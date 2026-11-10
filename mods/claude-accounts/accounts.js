// Claude accounts: where they are, who they are, how much they have used,
// and how to start Claude Code on one. No UI here.
//
// An account is a Claude Code config folder. ~/.claude is the default one;
// any other folder is used through CLAUDE_CONFIG_DIR. The list is kept in
// <herdr-app home>/data/claude-accounts/accounts.json.

import { exec, home, appHome, readTextFile, writeTextFile } from "herdr";

export const DATA = () => `${appHome()}/data/claude-accounts`;
const FILE = () => `${DATA()}/accounts.json`;
const PROGRAMS = () => `${appHome()}/programs.json`;
// programs.json keys this mod owns. Others are left as they are.
const KEY = "claude@";

export const tilde = (p) => (p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
export const untilde = (p) => (p === "~" ? home() : p.startsWith("~/") ? `${home()}${p.slice(1)}` : p);
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const isDefault = (dir) => untilde(dir) === `${home()}/.claude`;
// Single quotes for sh: a'b -> 'a'\''b'.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const parse = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

// Finds accounts when there is no list yet: ~/.claude, then each ~/.claude-*
// folder that Claude Code has used (it holds a .claude.json).
async function discover() {
  const out = [];
  if ((await readTextFile(`${home()}/.claude.json`)) !== null) out.push({ name: "main", dir: "~/.claude" });
  const ls = await exec("sh", ["-c", 'for d in "$HOME"/.claude-*/; do [ -f "$d.claude.json" ] && printf "%s\\n" "${d%/}"; done; true']);
  for (const d of (ls.stdout ?? "").split("\n").filter(Boolean)) {
    out.push({ name: slug(d.split("/").pop().replace(/^\.claude-/, "")) || "other", dir: tilde(d) });
  }
  return out;
}

export async function load() {
  const text = await readTextFile(FILE());
  const data = parse(text);
  if (data && Array.isArray(data.accounts)) {
    return { usage: data.usage === true, accounts: data.accounts, setup: data.setup ?? {}, last: data.last ?? null, text };
  }
  // Usage is off until the person turns it on: it reads their login token.
  const fresh = { usage: false, accounts: await discover(), setup: {}, last: null, text: null };
  await save(fresh);
  return fresh;
}

export async function save(state) {
  await exec("mkdir", ["-p", DATA()]);
  const { usage, accounts, setup, last } = state;
  const text = JSON.stringify({ usage, accounts, setup, last }, null, 2) + "\n";
  await writeTextFile(FILE(), text, (await readTextFile(FILE())) ?? null);
  state.text = text;
  await syncPrograms(accounts);
}

// One programs.json entry per account that is not the default, so Herdr's own
// agent menus offer "Claude (<name>)". The default is Herdr's built-in "claude".
async function syncPrograms(accounts) {
  const before = await readTextFile(PROGRAMS());
  const data = parse(before) ?? {};
  const programs = Object.fromEntries(Object.entries(data.programs ?? {}).filter(([k]) => !k.startsWith(KEY)));
  for (const a of accounts) {
    if (isDefault(a.dir)) continue;
    programs[`${KEY}${a.name}`] = { name: `Claude (${a.name})`, icon: "icons/claude.svg", run: ["env", `CLAUDE_CONFIG_DIR=${untilde(a.dir)}`, "claude"] };
  }
  const after = JSON.stringify({ ...data, programs }, null, 2) + "\n";
  if (after !== before) await writeTextFile(PROGRAMS(), after, before);
}

export async function email(a) {
  const f = isDefault(a.dir) ? `${home()}/.claude.json` : `${untilde(a.dir)}/.claude.json`;
  return parse(await readTextFile(f))?.oauthAccount?.emailAddress ?? null;
}

// The account's OAuth access token, as Claude Code stores it: the macOS
// Keychain (a service name per config folder), else .credentials.json.
async function token(a) {
  const dir = untilde(a.dir);
  const mac = await exec("uname", []).then((r) => r.stdout.trim() === "Darwin", () => false);
  if (mac) {
    let service = "Claude Code-credentials";
    if (!isDefault(dir)) {
      const h = await exec("sh", ["-c", 'printf %s "$1" | shasum -a 256', "sh", dir]);
      service += `-${(h.stdout ?? "").slice(0, 8)}`;
    }
    const r = await exec("security", ["find-generic-password", "-s", service, "-w"]);
    const t = parse((r.stdout ?? "").trim())?.claudeAiOauth?.accessToken;
    if (t) return t;
  }
  return parse(await readTextFile(`${dir}/.credentials.json`))?.claudeAiOauth?.accessToken ?? null;
}

// { five, week, fiveReset, weekReset } in percent and Date, or { error }.
// Uses the same (undocumented) endpoint as Claude Code's /usage.
export async function usage(a) {
  try {
    const t = await token(a);
    if (!t) return { error: "not logged in" };
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${t}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!r.ok) return { error: `usage ${r.status}` };
    const d = await r.json();
    const at = (s) => (s ? new Date(s) : null);
    return {
      five: Math.floor(d.five_hour?.utilization ?? 0),
      week: Math.floor(d.seven_day?.utilization ?? 0),
      fiveReset: at(d.five_hour?.resets_at),
      weekReset: at(d.seven_day?.resets_at),
    };
  } catch (e) {
    return { error: "usage unavailable" };
  }
}

// The account with the most headroom: the lowest of max(5h, week).
export function auto(accounts, use) {
  let best = null, score = 101;
  for (const a of accounts) {
    const u = use[a.name];
    if (!u || u.error) continue;
    const s = Math.max(u.five, u.week);
    if (s < score) { best = a; score = s; }
  }
  return best;
}

// The command for a terminal: optional setup, then Claude on the account,
// then the person's login shell, as Herdr's own agent launcher leaves it.
export async function argv(a, setup) {
  const shell = ((await exec("sh", ["-c", "printf %s \"${SHELL:-/bin/sh}\""])).stdout || "/bin/sh").trim();
  const claude = isDefault(a.dir) ? "claude" : `env CLAUDE_CONFIG_DIR=${q(untilde(a.dir))} claude`;
  const line = `${setup ? `${setup} && ` : ""}${claude}; exec ${q(shell)} -l`;
  return [shell, "-lc", line];
}

// A new account: makes its folder. Claude Code asks to log in on first start.
export async function add(state, name) {
  const n = slug(name);
  if (!n) return "Type a name: letters, digits, dots, dashes.";
  if (state.accounts.some((a) => a.name === n)) return `There is already an account called ${n}.`;
  const dir = `~/.claude-${n}`;
  const r = await exec("mkdir", ["-p", untilde(dir)]);
  if (r.code !== 0) return r.stderr || `Could not make ${dir}.`;
  state.accounts.push({ name: n, dir });
  await save(state);
  return { name: n, dir };
}

// Takes an account off the list. Its folder and login stay.
export async function remove(state, name) {
  state.accounts = state.accounts.filter((a) => a.name !== name);
  if (state.last === name) state.last = null;
  await save(state);
}

// The repo a folder is in (the main checkout's folder name), or null.
export async function repoName(folder) {
  if (!folder) return null;
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder });
  if (r.code !== 0) return null;
  const common = r.stdout.trim().replace(/\/\.git$/, "");
  return common.split("/").pop() || null;
}
