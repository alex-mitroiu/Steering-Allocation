import { createContext, useContext, useEffect, useState, useCallback } from "react";

export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

// Hash routing: #/guide, #/guide?line=GL-…, … Bare paths only; extra state stays in the page.
export function useRoute() {
  const read = () => { const h = window.location.hash.replace(/^#\/?/, ""); const [path, q] = h.split("?"); return { path: path || "dashboard", query: Object.fromEntries(new URLSearchParams(q || "")) }; };
  const [route, setRoute] = useState(read);
  useEffect(() => { const on = () => setRoute(read()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  return route;
}
export const go = (path, query) => { window.location.hash = `#/${path}${query ? "?" + new URLSearchParams(query).toString() : ""}`; };

// Loads data with a reload() handle; errors are kept for the page to show.
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const reload = useCallback(() => {
    setState(s => ({ ...s, loading: true }));
    return fn().then(data => setState({ data, error: null, loading: false }), error => setState(s => ({ data: s.data, error, loading: false })));
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload, setData: data => setState(s => ({ ...s, data })) };
}
