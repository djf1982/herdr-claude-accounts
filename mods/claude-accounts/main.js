// Claude Accounts: a dialog that starts Claude Code on the account you pick,
// with each account's 5-hour and weekly usage. Type a branch first to start
// it in a new git worktree instead. Opened with mod.open:claude-accounts.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, focused, notify } from "herdr";
import * as A from "./accounts.js";

const AUTO = { name: "auto", dir: "" };

const until = (d) => {
  if (!d) return "";
  const m = Math.max(0, Math.round((d.getTime() - Date.now()) / 60000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export default class ClaudeAccounts extends View {
  init(_props, cx) {
    this.state = null; // { usage, accounts, setup, last }
    this.mail = {}; // name -> email
    this.use = {}; // name -> usage, or { error }
    this.at = 0;
    this.adding = false;
    this.armed = null; // the account a first remove click armed
    this.error = "";
    this.busy = false;
    this.inFocus = true;
    const make = (placeholder) => {
      const i = InputState.new({ value: "", placeholder });
      i.on("submit", (_e, cx) => this.enter(cx));
      i.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
      i.on("focus", (_e, cx) => { this.inFocus = true; cx.notify(); });
      i.on("blur", (_e, cx) => { this.inFocus = false; cx.notify(); });
      return i;
    };
    this.branch = make("branch for a new worktree (optional)");
    this.name = make("account name, e.g. work");
    this.branch.focus();
    cx.timer.after(400, () => this.input().focus());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        this.state = await A.load();
        const i = this.rows().findIndex((a) => a.name === this.state.last);
        this.at = Math.max(0, i);
        cx.notify();
        await this.refresh(cx);
      } catch (e) { this.error = String(e); cx.notify(); }
    });
  }

  async refresh(cx) {
    const list = this.state.accounts;
    await Promise.all(list.map(async (a) => { this.mail[a.name] = await A.email(a); }));
    cx.notify();
    if (!this.state.usage) return;
    await Promise.all(list.map(async (a) => { this.use[a.name] = await A.usage(a); cx.notify(); }));
  }

  // Auto first when usage is on and there is more than one account.
  rows() {
    const list = this.state?.accounts ?? [];
    return this.state?.usage && list.length > 1 ? [AUTO, ...list] : list;
  }

  input() { return this.adding ? this.name : this.branch; }

  close() { closeOverlay(props()?.overlay); }

  move(d, cx) {
    const n = this.rows().length;
    if (!n) return;
    this.at = (this.at + d + n) % n;
    this.armed = null;
    cx.notify();
  }

  key(e, cx) {
    if (e.key === "down" || e.key === "up") { this.move(e.key === "down" ? 1 : -1, cx); cx.stop_propagation(); return; }
    if (e.modifiers?.platform && /^[1-9]$/.test(e.key) && !this.adding) {
      const i = Number(e.key) - 1;
      if (i < this.rows().length) { this.at = i; this.start(this.rows()[i], cx); }
      cx.stop_propagation();
      return;
    }
    if (e.key === "enter" && !this.inFocus) { this.enter(cx); cx.stop_propagation(); }
  }

  enter(cx) {
    if (this.adding) return this.addAccount(cx);
    this.start(this.rows()[this.at], cx);
  }

  start(a, cx) {
    if (!a || this.busy) return;
    if (a === AUTO) {
      const pick = A.auto(this.state.accounts, this.use);
      if (!pick) { this.error = "No usage yet to choose from. Pick an account."; return cx.notify(); }
      a = pick;
    }
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const f = focused();
        const branch = this.branch.value().trim();
        const repo = await A.repoName(f?.cwd);
        const setup = branch && repo ? this.state.setup?.[repo] ?? "" : "";
        const argv = await A.argv(a, setup);
        this.state.last = a.name;
        await A.save(this.state);
        this.close();
        if (branch) {
          if (!repo) return notify({ title: "Claude Accounts", body: "This folder is not in a git repository.", level: "warning" });
          openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: f?.space, branch, argv } });
        } else {
          run("tab.new", { name: `claude (${a.name})`, argv });
        }
      } catch (e) { this.busy = false; this.error = String(e); cx.notify(); }
    });
  }

  addAccount(cx) {
    const name = this.name.value().trim();
    cx.spawn(async (cx) => {
      const r = await A.add(this.state, name);
      if (typeof r === "string") { this.error = r; return cx.notify(); }
      this.close();
      // A new config folder: Claude Code starts its login on first run.
      run("tab.new", { name: `claude login (${r.name})`, argv: await A.argv(r, "") });
    });
  }

  toggleAdd(cx) {
    this.adding = !this.adding;
    this.error = "";
    this.name.set_value("");
    this.input().focus();
    cx.notify();
  }

  removeAccount(a, cx) {
    if (this.armed !== a.name) { this.armed = a.name; return cx.notify(); }
    cx.spawn(async (cx) => {
      await A.remove(this.state, a.name);
      this.armed = null;
      this.at = 0;
      cx.notify();
    });
  }

  toggleUsage(cx) {
    this.state.usage = !this.state.usage;
    this.at = 0;
    cx.spawn(async (cx) => { await A.save(this.state); cx.notify(); await this.refresh(cx); });
  }

  bar(pct, t) {
    const c = pct >= 90 ? t.blocked : pct >= 70 ? t.ansi3 : t.done;
    return div().flex_none().w(44).h(4).rounded(2).bg(t.raised).child(div().h(4).rounded(2).w(Math.max(1, Math.round((44 * Math.min(pct, 100)) / 100))).bg(c));
  }

  meter(label, pct, reset, t) {
    return h_flex().flex_none().gap(5).items_center().text_size(11)
      .child(div().text_color(t.dim).child(label))
      .child(this.bar(pct, t))
      .child(div().w(30).text_color(t.muted).child(`${pct}%`))
      .tooltip(reset ? `resets in ${until(reset)}` : "");
  }

  row(a, i, t) {
    const on = i === this.at;
    const u = this.use[a.name];
    const auto = a === AUTO;
    const pick = auto ? A.auto(this.state.accounts, this.use) : null;
    const sub = auto ? (pick ? `now: ${pick.name}` : "the account with the most headroom") : `${this.mail[a.name] ?? "not logged in yet"} · ${A.tilde(A.untilde(a.dir))}`;
    return h_flex().id(`acct-${i}`).flex_none().h(46).px(10).gap(10).items_center().rounded(7).cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.at = i; this.start(a, cx); })
      .child(div().flex_none().w(22).text_size(11).text_color(t.dim).child(i < 9 ? `⌘${i + 1}` : ""))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(auto ? "Auto" : a.name))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(sub)))
      .when(Boolean(this.state.usage && !auto), (el) => el.child(
        !u ? div().text_size(11).text_color(t.dim).child("…")
          : u.error ? div().text_size(11).text_color(t.dim).child(u.error)
          : v_flex().flex_none().gap(3).child(this.meter("5h", u.five, u.fiveReset, t)).child(this.meter("wk", u.week, u.weekReset, t))))
      .when(!auto, (el) => el.child(
        div().id(`rm-${i}`).flex_none().px(6).py(2).rounded(5).text_size(11)
          .text_color(this.armed === a.name ? t.blocked : t.dim)
          .hover((s) => s.bg(t.raised))
          .on_click((_e, cx) => { cx.stop_propagation(); this.removeAccount(a, cx); })
          .tooltip("Take it off the list. Its folder and login stay.")
          .child(this.armed === a.name ? "remove?" : "×")));
  }

  render(cx) {
    const t = theme();
    const s = this.state;
    const rows = this.rows();
    const link = (id, text, fn) => div().id(id).cursor_pointer().text_color(t.muted).hover((x) => x.text_color(t.foreground)).on_click((_e, cx) => fn(cx)).child(text);
    return v_flex().id("claude-accounts").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(this.adding ? "Add a Claude account" : "Start Claude as…"))
        .child(div().text_size(11).text_color(t.dim).child(s ? `${s.accounts.length} account${s.accounts.length === 1 ? "" : "s"}` : "")))
      .when(this.adding, (el) => el.child(div().text_color(t.muted).child("Makes ~/.claude-<name> and starts Claude Code there, so you can log in.")))
      .child(Input.new(this.input()).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inFocus ? t.accent : t.input).bg(t.background).text_color(t.foreground))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(!this.adding, (el) => el.child(
        v_flex().id("acct-list").flex_1().min_h(0).overflow_y_scroll().gap(2)
          .when(!s, (el) => el.child(div().text_color(t.muted).child("…")))
          .when(Boolean(s && rows.length === 0), (el) => el.child(div().p(10).text_color(t.dim).child("No accounts yet. Add one.")))
          .children(s ? rows.map((a, i) => this.row(a, i, t)) : [])))
      .when(this.adding, (el) => el.child(div().flex_1()))
      .child(h_flex().gap(12).text_size(11).items_center()
        .child(link("add", this.adding ? "back" : "+ add account", (cx) => this.toggleAdd(cx)))
        .when(Boolean(s && !this.adding), (el) => el.child(link("usage", `usage: ${s.usage ? "on" : "off"}`, (cx) => this.toggleUsage(cx))))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(this.busy ? "starting…" : this.adding ? "↵ add · esc close" : "↑↓ choose · ↵ or ⌘1–9 start · esc close")));
  }
}
