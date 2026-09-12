// A 2D context that remembers instead of painting. Every property set and every method call is appended
// to a log, in order, with its arguments — so two renderers that produce the same log would paint the same
// pixels, and a refactor that changes the log changed the picture. No canvas library is needed.
export function makeRecorder() {
    const log = [];
    const round = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
    const args = (a) => a.map(v => (Array.isArray(v) ? v.map(round) : round(v)));
    const state = {};
    const ctx = new Proxy({}, {
        get(_, prop) {
            if (prop === 'measureText') return (s) => ({ width: String(s).length * 6 });
            if (prop === '__log') return log;
            if (typeof prop === 'symbol') return undefined;
            if (prop in state) return state[prop];
            return (...a) => { log.push([String(prop), args(a)]); return undefined; };
        },
        set(_, prop, value) {
            state[prop] = value;
            log.push(['=' + String(prop), [round(value)]]);
            return true;
        },
    });
    return ctx;
}

export function makeCanvasFactory() {
    return (w, h) => {
        const ctx = makeRecorder();
        return { width: w, height: h, getContext: () => ctx, __ctx: ctx };
    };
}
