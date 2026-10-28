const SEAL_RX = /<seal-(\d+)\/>/g;

export function tidyOutput(text, original) {
    let t = String(text ?? '');
    // <think> 류 사고 블록 제거 (변형 태그 포함)
    t = t.replace(/<(think|thinking|thought|reasoning|reflection)>[\s\S]*?<\/\1>/gi, '');
    // 닫는 태그만 남은 경우: 태그 이전 전체가 사고 과정
    t = t.replace(/^[\s\S]*?<\/(think|thinking|thought|reasoning|reflection)>/i, '');
    t = t.trim();
    // 원문에 코드 펜스가 없는데 전체가 펜스로 감싸져 나온 경우
    if (!/```/.test(original)) {
        const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
        if (fence) t = fence[1].trim();
    }
    // "Translation:" 류 접두 라벨 제거
    t = t.replace(/^(?:translation|번역|译文|翻訳)\s*[:：]\s*/i, '');
    // PASSAGE 마커가 그대로 복사돼 나온 경우
    t = t.replace(/^===\s*PASSAGE START\s*===\s*\n?/i, '').replace(/\n?===\s*PASSAGE END\s*===\s*$/i, '').trim();
    return t;
}

export function scriptRatio(text, code) {
    const t = String(text || '').replace(/\s+/g, '');
    if (!t) return 0;
    let rx;
    switch (code) {
        case 'ko': rx = /[\uAC00-\uD7A3]/g; break;
        case 'ja': rx = /[\u3040-\u30FF\u4E00-\u9FFF]/g; break;
        case 'zh': rx = /[\u4E00-\u9FFF]/g; break;
        case 'ru': rx = /[\u0400-\u04FF]/g; break;
        case 'th': rx = /[\u0E00-\u0E7F]/g; break;
        default: rx = /[A-Za-z]/g; break;
    }
    return (t.match(rx) || []).length / t.length;
}

export function validateRendering(out, sealedChunk, srcCode, dstCode, { structured = false } = {}) {
    const source = String(sealedChunk).replace(SEAL_RX, '').trim();
    if (!out || !out.trim()) return 'empty reply';
    if (source.length < 80) return null; // 짧은 조각은 판별이 불안정하므로 통과

    // 1) 언어 검사: 원문이 확실히 원문 언어인데 결과도 여전히 원문 언어면 번역이 아니다
    const distinctive = ['ko', 'ja', 'zh', 'ru', 'th'];
    if (!structured && distinctive.includes(dstCode) && scriptRatio(out, dstCode) < 0.25 && scriptRatio(source, dstCode) < 0.25) {
        return `reply is not written in the target language`;
    }
    if (srcCode !== dstCode && distinctive.includes(srcCode)
        && scriptRatio(source, srcCode) > 0.5 && scriptRatio(out, srcCode) > 0.5) {
        return 'reply is still in the source language';
    }

    // 2) 구조 검사: 문단 수가 크게 어긋나면 해설/분석일 가능성이 높다
    const srcBlocks = source.split(/\n{2,}/).filter(b => b.trim()).length;
    const outBlocks = out.split(/\n{2,}/).filter(b => b.trim()).length;
    if (!structured && srcBlocks >= 4 && (outBlocks < srcBlocks * 0.45 || outBlocks > srcBlocks * 2.2)) {
        return `paragraph structure mismatch (source ${srcBlocks}, reply ${outBlocks})`;
    }

    // 3) 길이 검사: 원문 대비 지나치게 짧으면 요약/누락
    if (out.length < source.length * 0.25) {
        return 'reply is far shorter than the passage';
    }
    return null;
}
