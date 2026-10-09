import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');

test('settings initialize independently without mutating original Interpres settings', () => {
    const original = { enabled: false, viewLang: 'ja' };
    const settings = { interpres: original };
    const context = vm.createContext({ extension_settings: settings, structuredClone });
    vm.runInContext("const MODULE_NAME = 'interpres_codeblocks';" +
        source.slice(source.indexOf('const DEFAULT_SETTINGS ='), source.indexOf('function currentChatId(')), context);
    const result = context.getSettings();
    assert.equal(result.translateCodeBlocks, true);
    assert.equal(result.viewLang, 'ko');
    assert.equal(settings.interpres, original);
    assert.equal(settings.interpres.viewLang, 'ja');
    assert.equal(settings.interpres_codeblocks, result);
});

test('UI selectors, style names, message stamps and slash commands use the standalone namespace', () => {
    assert.ok(html.includes('id="icb_settings"'));
    assert.ok(css.includes('#icb_settings'));
    assert.ok(source.includes('message.extra.interpres_codeblocks_src'));
    for (const command of ['icb', 'icb-msg', 'icb-chat', 'icb-book']) {
        assert.ok(source.includes(`name: '${command}'`));
    }
    assert.ok(!source.includes('extra.interpres_src'));
    for (const text of [source, html, css]) {
        assert.ok(!/\binterp(?=[_-]|\b)/.test(text));
    }
});
