// Parse fenced blocks by line, preserving exact boundaries, CRLF and open fences.
export function fencedBlocks(value) {
    const text = String(value ?? '');
    const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g)];
    const blocks = [];
    let open = null;
    for (const line of lines) {
        const plain = line[0].replace(/[\r\n]+$/, '');
        if (open) {
            const closing = plain.match(/^[\t ]*(`{3,}|~{3,})[\t ]*$/);
            if (closing && closing[1][0] === open.mark[0] && closing[1].length >= open.mark.length) {
                blocks.push({ start: open.start, end: line.index + plain.length,
                    opening: open.opening, closing: plain, text: text.slice(open.start, line.index + plain.length) });
                open = null;
            }
        } else {
            const opening = plain.match(/^[\t ]*(`{3,}|~{3,})([^\r\n]*)$/);
            if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
                open = { start: line.index, mark: opening[1], opening: plain };
            }
        }
    }
    if (open) blocks.push({ start: open.start, end: text.length, opening: open.opening,
        closing: null, text: text.slice(open.start) });
    return blocks;
}

export function pairedBlocks(original, translated) {
    const from = fencedBlocks(original);
    const to = fencedBlocks(translated);
    if (!from.length || from.length !== to.length) return [];
    // A missing/altered fence cannot be safely matched to a rendered block.
    if (from.some((block, i) => block.opening !== to[i].opening || block.closing !== to[i].closing)) return [];
    return to.map((block, i) => ({ ...block, original: from[i].text }));
}

export function stripCodeAnchors(value) {
    const text = String(value ?? '');
    const blocks = fencedBlocks(text);
    return text.replace(/\n\n<div class="icb_code_(?:start|end)(?: icb_code_block_\d+)?" data-icb-block="\d+"><\/div>\n\n/g,
        (marker, offset) => blocks.some(block => offset >= block.start && offset < block.end) ? marker : '');
}

export function renderCodeChoices(original, translated, originals = [], anchors = false) {
    const pairs = pairedBlocks(original, translated);
    if (!pairs.length) return String(translated ?? '');
    const selected = new Set(originals);
    let result = '';
    let cursor = 0;
    for (const [index, block] of pairs.entries()) {
        result += translated.slice(cursor, block.start);
        const body = selected.has(index) ? block.original : block.text;
        const start = `\n\n<div class="icb_code_start icb_code_block_${index}" data-icb-block="${index}"></div>\n\n`;
        const end = `\n\n<div class="icb_code_end icb_code_block_${index}" data-icb-block="${index}"></div>\n\n`;
        // Do not put the end marker inside an unfinished fenced block.
        result += anchors && block.closing !== null ? start + body + end : body;
        cursor = block.end;
    }
    return result + translated.slice(cursor);
}

export function toggleCodeChoice(originals, index, count) {
    if (!Number.isInteger(index) || index < 0 || index >= count) return [...originals];
    const selected = new Set(originals.filter(n => Number.isInteger(n) && n >= 0 && n < count));
    if (selected.has(index)) selected.delete(index);
    else selected.add(index);
    return [...selected].sort((a, b) => a - b);
}
