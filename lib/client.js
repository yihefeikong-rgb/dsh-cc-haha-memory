window.__ModuleLoader__.load({ id: "dsh-memory", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/src/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  default: () => index_default,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// client/src/Panel.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var TYPES = [
  { value: "user", label: "\u7528\u6237\u753B\u50CF" },
  { value: "feedback", label: "\u53CD\u9988" },
  { value: "project", label: "\u9879\u76EE\u72B6\u6001" },
  { value: "reference", label: "\u53C2\u8003" }
];
var EMPTY = { title: "", content: "", type: "reference", tags: [], scope: "project" };
async function api(path, options = {}, sessionId = "") {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`/memory/api/${path}${separator}sessionId=${encodeURIComponent(sessionId)}`, options);
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error ?? `\u8BF7\u6C42\u5931\u8D25: ${response.status}`);
  return data;
}
function MemoryPanel({ sessionId, useSessions }) {
  const cwd = useSessions((state) => state.byId?.[sessionId]?.cwd);
  const [entries, setEntries] = (0, import_react.useState)([]);
  const [selected, setSelected] = (0, import_react.useState)(null);
  const [editing, setEditing] = (0, import_react.useState)(null);
  const [query, setQuery] = (0, import_react.useState)("");
  const [expanded, setExpanded] = (0, import_react.useState)({});
  const [loading, setLoading] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)("");
  const [notice, setNotice] = (0, import_react.useState)("");
  const [scopeInfo, setScopeInfo] = (0, import_react.useState)({ project: null, scopes: ["\u901A\u7528"], cwdKnown: false });
  const refresh = (0, import_react.useCallback)(async (q = "") => {
    setLoading(true);
    setError("");
    try {
      if (q.trim()) {
        const data = await api(`search?q=${encodeURIComponent(q)}&limit=50`, {}, sessionId);
        setEntries((data.results ?? []).map((r) => ({ ...r, section: pathSection(r.id ?? r.rel) })));
      } else {
        const data = await api("index", {}, sessionId);
        setEntries(data.entries ?? []);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);
  (0, import_react.useEffect)(() => {
    void refresh();
  }, [refresh]);
  (0, import_react.useEffect)(() => {
    void api("scope", {}, sessionId).then((data) => setScopeInfo(data)).catch((e) => setError(e.message));
  }, [sessionId, cwd]);
  const groups = (0, import_react.useMemo)(() => {
    const map = /* @__PURE__ */ new Map();
    for (const e of entries) {
      const section = e.section || "\u672A\u5206\u7C7B";
      if (!map.has(section)) map.set(section, []);
      map.get(section).push(e);
    }
    return [...map.entries()];
  }, [entries]);
  const toggleSection = (0, import_react.useCallback)((section) => {
    setExpanded((prev) => ({ ...prev, [section]: !prev[section] }));
  }, []);
  const openEntry = (0, import_react.useCallback)(async (entry) => {
    try {
      const data = await api(`get?id=${encodeURIComponent(entry.rel ?? entry.id ?? entry.title)}`, {}, sessionId);
      setSelected(data.memory);
      setEditing(null);
    } catch (e) {
      setError(e.message);
    }
  }, [sessionId]);
  const save = (0, import_react.useCallback)(async () => {
    if (!editing?.title?.trim() || !editing?.content?.trim()) {
      setError("\u6807\u9898\u548C\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A");
      return;
    }
    try {
      if (editing.__new) {
        await api("write", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: editing.title,
            content: editing.content,
            type: editing.type,
            tags: editing.tags,
            description: editing.content.split("\n")[0].slice(0, 120),
            scope: editing.scope
          })
        }, sessionId);
      } else {
        await api("update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: editing.id, ...editing, __new: void 0 })
        }, sessionId);
      }
      setEditing(null);
      setSelected(null);
      setNotice(editing.__new ? "\u5DF2\u5199\u5165" : "\u5DF2\u66F4\u65B0");
      setTimeout(() => setNotice(""), 2e3);
      void refresh(query);
    } catch (e) {
      setError(e.message);
    }
  }, [editing, query, refresh, sessionId]);
  const remove = (0, import_react.useCallback)(async (entry) => {
    if (!window.confirm(`\u5220\u9664\u8BB0\u5FC6\u300C${entry.title ?? entry.id}\u300D?`)) return;
    try {
      await api("delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id })
      }, sessionId);
      setSelected(null);
      setNotice("\u5DF2\u5220\u9664");
      setTimeout(() => setNotice(""), 2e3);
      void refresh(query);
    } catch (e) {
      setError(e.message);
    }
  }, [query, refresh, sessionId]);
  const runImport = (0, import_react.useCallback)(async () => {
    setLoading(true);
    try {
      const data = await api("import", { method: "POST" }, sessionId);
      setNotice(`\u5BFC\u5165\u5B8C\u6210:\u65B0\u589E ${data.imported ?? 0},\u8DF3\u8FC7 ${data.skipped ?? 0}`);
      setTimeout(() => setNotice(""), 4e3);
      void refresh(query);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [query, refresh, sessionId]);
  const border = "1px solid var(--border-color, #ddd)";
  const muted = { fontSize: 12, color: "#888" };
  const chip = { fontSize: 11, color: "#aaa", border: "1px solid #ddd", borderRadius: 8, padding: "0 6px" };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: "12px 0" }, children: [
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { color: "#c0392b", marginBottom: 8 }, children: [
      "\u26A0 ",
      error
    ] }),
    notice && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { color: "#27ae60", marginBottom: 8 }, children: [
      "\u2713 ",
      notice
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...muted, marginBottom: 8 }, children: [
      "\u5F53\u524D\u4F5C\u7528\u57DF\uFF1A\u901A\u7528",
      scopeInfo.project ? ` + ${scopeInfo.project}` : "\uFF08\u672A\u8BC6\u522B\u9879\u76EE\uFF0C\u4EC5\u901A\u7528\uFF09"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          value: query,
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => e.key === "Enter" && void refresh(e.target.value),
          placeholder: "\u641C\u7D22\u8BB0\u5FC6\u2026",
          style: { flex: 1, padding: "6px 10px", borderRadius: 6, border }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: () => {
        setEditing({ ...EMPTY, scope: scopeInfo.project ? "project" : "general", __new: true });
        setSelected(null);
      }, style: { padding: "6px 14px" }, children: "\uFF0B \u65B0\u5EFA" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: () => void runImport(), style: { padding: "6px 14px" }, children: "\u5BFC\u5165" })
    ] }),
    loading && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...muted, padding: 8 }, children: "\u52A0\u8F7D\u4E2D\u2026" }),
    !loading && groups.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...muted, padding: 8 }, children: "\u6682\u65E0\u8BB0\u5FC6" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 14, alignItems: "flex-start" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { flex: 1, minWidth: 300 }, children: groups.map(([section, items]) => {
        const open = expanded[section] ?? false;
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginBottom: 6, border, borderRadius: 8, overflow: "hidden" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "div",
            {
              onClick: () => toggleSection(section),
              style: { padding: "7px 10px", cursor: "pointer", fontWeight: 600, fontSize: 13, background: "var(--hover-bg, #f5f5f5)", display: "flex", justifyContent: "space-between", alignItems: "center" },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
                  "\u{1F4C1} ",
                  section
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: chip, children: items.length })
              ]
            }
          ),
          open && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { padding: "4px 6px" }, children: items.map((e) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "div",
            {
              onClick: () => void openEntry(e),
              style: { padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 13 },
              onMouseEnter: (ev) => {
                ev.currentTarget.style.background = "var(--hover-bg, #f0f0f0)";
              },
              onMouseLeave: (ev) => {
                ev.currentTarget.style.background = "transparent";
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 500 }, children: e.title ?? e.id }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: e.description })
              ]
            },
            e.rel ?? e.id ?? e.title
          )) })
        ] }, section);
      }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { flex: 1.4, border, borderRadius: 8, padding: 12, minHeight: 300 }, children: editing ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: editing.title, onChange: (e) => setEditing({ ...editing, title: e.target.value }), placeholder: "\u6807\u9898", style: { width: "100%", padding: 6, marginBottom: 8, borderRadius: 4, border } }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, marginBottom: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", { value: editing.type, onChange: (e) => setEditing({ ...editing, type: e.target.value }), style: { padding: 6, borderRadius: 4 }, children: TYPES.map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: t.value, children: t.label }, t.value)) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: (editing.tags ?? []).join(", "), onChange: (e) => setEditing({ ...editing, tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }), placeholder: "\u6807\u7B7E(\u9017\u53F7\u5206\u9694)", style: { flex: 1, padding: 6, borderRadius: 4, border } })
        ] }),
        editing.__new && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginBottom: 8 }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { value: editing.scope, onChange: (e) => setEditing({ ...editing, scope: e.target.value }), style: { padding: 6, borderRadius: 4 }, children: [
          scopeInfo.project && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: "project", children: [
            "\u5F53\u524D\u9879\u76EE\uFF1A",
            scopeInfo.project
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "general", children: "\u901A\u7528\u8BB0\u5FC6" })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { value: editing.content, onChange: (e) => setEditing({ ...editing, content: e.target.value }), placeholder: "\u5185\u5BB9(Markdown)", style: { width: "100%", height: 260, padding: 6, borderRadius: 4, border, fontFamily: "monospace", fontSize: 12 } }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 8, display: "flex", gap: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: () => void save(), style: { padding: "6px 16px" }, children: "\u4FDD\u5B58" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: () => setEditing(null), style: { padding: "6px 16px" }, children: "\u53D6\u6D88" })
        ] })
      ] }) : selected ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: { margin: "0 0 4px", fontSize: 15 }, children: selected.name }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: muted, children: [
          "\u7C7B\u578B:",
          TYPES.find((t) => t.value === selected.type)?.label ?? selected.type,
          selected.tags?.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
            " \xB7 \u6807\u7B7E:",
            selected.tags.join(", ")
          ] }),
          selected.updated && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
            " \xB7 \u66F4\u65B0:",
            selected.updated.slice(0, 10)
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 11, color: "#aaa" }, children: selected.path })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { style: { whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.6, margin: "8px 0" }, children: selected.content }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: () => setEditing({ ...selected }), style: { padding: "6px 16px" }, children: "\u7F16\u8F91" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: () => void remove(selected), style: { padding: "6px 16px", color: "#c0392b" }, children: "\u5220\u9664" })
        ] })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...muted, paddingTop: 24, textAlign: "center" }, children: "\u9009\u62E9\u5DE6\u4FA7\u8BB0\u5FC6\u67E5\u770B\u8BE6\u60C5,\u6216\u70B9\u300C\uFF0B \u65B0\u5EFA\u300D\u8BB0\u5F55\u65B0\u8BB0\u5FC6" }) })
    ] })
  ] });
}
function pathSection(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  return normalized.includes("/") ? normalized.split("/")[0] : "\u672A\u5206\u7C7B";
}

// client/src/index.tsx
var inject = ["slots"];
function apply(ctx) {
  const slots = ctx.get("slots");
  if (slots === void 0) return;
  slots.inject("conversation.view", () => slots.register(
    { name: "conversation.view", id: "memory", order: 130, label: () => "\u8BB0\u5FC6" },
    MemoryPanel
  ));
}
var index_default = { inject, apply };

return module.exports; } });
//# sourceMappingURL=client.js.map
