/**
 * A stack of ladders under one strip, as the viewer and the editor both draw it: the editable ladder
 * first (A), then every layer (B, C…), each with its style, its letter and title, and its brackets.
 *
 * Pure: takes the ladders' recipes, returns what to draw and the layout to draw it in. The viewer's
 * controller used to do this with its own state; the editor needs the same composition for a diagram it
 * imported or drew, so it lives here, next to the renderer.
 */
import { buildLadder } from './engine.js';
import { toLineStyle } from './export.js';
import { intervalBrackets } from './figures.js';

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** What a mechanism is called when a stacked ladder has no title of its own. */
export const SHORT = Object.freeze({
    avnodal: 'Sinus / AV conduction', avb3: 'Complete AV block', avnrt: 'AVNRT', avrt: 'Orthodromic AVRT',
    pvc: 'Sinus + ectopy', vt: 'Ventricular tachycardia', afib: 'Atrial fibrillation', flutter: 'Atrial flutter',
    at: 'Atrial tachycardia', jt: 'Junctional tachycardia', avrtAnti: 'Antidromic AVRT', hisExtra: 'Concealed His extrasystoles', pjrt: 'PJRT',
});

/** How many caption lines to reserve under a ladder: one per ~140 characters, at most three. */
export const capLines = (c) => (c ? Math.min(3, Math.ceil(String(c).length / 140)) : 0);

/**
 * Every ladder drawn, top to bottom.
 * @param items  [{ mechanism, params, tiers, beats, atrial, style?, title?, caption?, brackets?, ladder? }]
 *               — `ladder` is built when absent (a layer keeps the one it was built with).
 * @param o.style        the default tier style ('bands' | 'lines')
 * @param o.durationMs   the strip length, for ladders built here
 * @returns [{ ...item, style, ladder, drawn, bracketList, letter, shownTitle }]
 */
export function composeStack(items, { style = 'bands', durationMs } = {}) {
    const many = items.length > 1;
    return items.map((l, i) => {
        const st = l.style || style;
        const ladder = l.ladder || buildLadder({ beats: l.beats, atrial: l.atrial, mechanism: l.mechanism, params: l.params, tiers: l.tiers, durationMs });
        const drawn = st === 'lines' && ladder ? toLineStyle(ladder) : ladder;
        return {
            ...l, style: st, ladder, drawn,
            bracketList: l.brackets ? intervalBrackets(l, drawn, l.brackets) : null,
            letter: many ? LETTERS[i] || String(i + 1) : null,
            shownTitle: l.title || (many ? (SHORT[l.mechanism] || l.mechanism) : ''),
        };
    });
}

/**
 * The layout a composed stack needs: its tier sets, whether a title row is shown, caption and bracket rows.
 * `makeLayout` is the renderer's (render.js); it is passed in so this module depends on no renderer.
 */
export function layoutForStack(stack, { makeLayout, style = 'bands', stripH, gap, groupGap, footer }) {
    const groups = stack.map(l => l.tiers);
    const titles = stack.some(l => l.letter || l.shownTitle);
    const captionLines = stack.map(l => capLines(l.caption));
    const styles = stack.map(l => l.style);
    const bracketRows = stack.map(l => !!l.bracketList?.some(b => b.row !== 'strip'));
    const key = JSON.stringify([groups, titles, captionLines, styles, bracketRows, stripH, footer]);
    const layout = makeLayout({ groups, titles, captionLines, style, styles, bracketRows,
                                ...(stripH != null ? { stripH } : {}), ...(gap != null ? { gap } : {}),
                                ...(groupGap != null ? { groupGap } : {}), ...(footer != null ? { footer } : {}) });
    return { key, layout };
}

/** The `frameInput`-shaped view of a composed stack: the first ladder as current, the rest as layers. */
export function frameGroups(stack) {
    const [cur, ...rest] = stack;
    return {
        ladder: cur?.drawn ?? null,
        current: cur ? { letter: cur.letter, title: cur.shownTitle, caption: cur.caption, brackets: cur.bracketList } : {},
        layers: rest.map(l => ({ letter: l.letter, title: l.shownTitle, caption: l.caption, ladder: l.drawn, brackets: l.bracketList })),
    };
}
