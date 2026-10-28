const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
if (!fs.existsSync(path.join(root, 'src/endpoints/backends/chat-completions.js'))) {
    throw new Error('SillyTavern 설치 폴더에서 실행해 주세요.');
}
const configPath = path.join(root, 'config.yaml');
let config = fs.readFileSync(configPath, 'utf8');
const flag = /^enableServerPlugins\s*:\s*(true|false)\s*(?:#.*)?$/m;
if (/^enableServerPlugins\s*:/m.test(config) && !flag.test(config)) {
    throw new Error('config.yaml의 enableServerPlugins 값을 확인해 주세요.');
}
const directory = path.join(root, 'plugins/interpres-background');
fs.mkdirSync(directory, { recursive: true });
for (const name of ['index.mjs', 'jobs.mjs', 'backend.mjs', 'translation-validation.mjs']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(directory, name));
}
if (!fs.existsSync(configPath + '.before-interpres-background')) fs.copyFileSync(configPath, configPath + '.before-interpres-background');
config = flag.test(config) ? config.replace(flag, 'enableServerPlugins: true') : config + '\nenableServerPlugins: true\n';
fs.writeFileSync(configPath, config);
console.log('백그라운드 서버 플러그인 설치 완료. SillyTavern을 재시작한 뒤 Interpres 모델 탭에서 커넥션 프로필과 서버 백그라운드 번역을 선택하세요.');
