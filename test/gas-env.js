'use strict';
// gas/Code.gs を Node 上で動かすための、Apps Script サービスの簡易モック。
// run() のたびに新しいグローバル環境で Code.gs を読み込み直す（Apps Script の実行ごとの挙動に合わせる）。
// シート・プロパティ・キャッシュ・トリガー・HTTP 呼び出しは env.state に残る。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');

// Sheets の書き込み時の変換をまねる
function sheetValue(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith("'")) return value.slice(1); // 先頭の ' は「文字列として扱う」印で、値には含まれない
  if (/^[=+]/.test(value)) throw new Error('数式として解釈される値がそのまま書き込まれました: ' + value);
  if (/^\d{16,}$/.test(value)) return Number(value); // 長い数字は数値になり桁が壊れる
  return value;
}

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getRow() {
    return this.row;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  getValue() {
    return this.getValues()[0][0];
  }
  setValues(values) {
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.rows.length <= idx) this.sheet.rows.push([]);
      line.forEach((v, c) => {
        this.sheet.rows[idx][this.col - 1 + c] = sheetValue(v);
      });
    });
    return this;
  }
  setValue(value) {
    return this.setValues([[value]]);
  }
  clearContent() {
    return this.setValues(Array.from({ length: this.numRows }, () => Array(this.numCols).fill('')));
  }
  createTextFinder(text) {
    const range = this;
    const finder = {
      entire: false,
      caseSensitive: false,
      matchEntireCell(b) {
        finder.entire = b;
        return finder;
      },
      matchCase(b) {
        finder.caseSensitive = b;
        return finder;
      },
      findNext() {
        const values = range.getValues();
        for (let r = 0; r < values.length; r++) {
          for (let c = 0; c < values[r].length; c++) {
            let cell = String(values[r][c]);
            let target = String(text);
            if (!finder.caseSensitive) {
              cell = cell.toLowerCase();
              target = target.toLowerCase();
            }
            if (finder.entire ? cell === target : cell.includes(target)) {
              return new MockRange(range.sheet, range.row + r, range.col + c, 1, 1);
            }
          }
        }
        return null;
      },
    };
    return finder;
  }
}

class MockSheet {
  constructor(parent, name) {
    this.parent = parent;
    this.name = name;
    this.rows = [];
    this.frozenRows = 0;
  }
  getParent() {
    return this.parent;
  }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i].some((v) => v !== '' && v !== undefined)) return i + 1;
    }
    return 0;
  }
  appendRow(values) {
    this.rows[this.getLastRow()] = values.map(sheetValue);
    return this;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error('範囲が不正です');
    return new MockRange(this, row, col, numRows, numCols);
  }
  deleteRows(start, count) {
    if (start <= this.frozenRows + 1 && start - 1 + count >= this.rows.length) {
      throw new Error('Sorry, it is not possible to delete all non-frozen rows.');
    }
    this.rows.splice(start - 1, count);
  }
  setFrozenRows(n) {
    this.frozenRows = n;
  }
}

class MockSpreadsheet {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sheets = [];
    this.timeZone = 'America/Los_Angeles';
  }
  getId() {
    return this.id;
  }
  getUrl() {
    return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit';
  }
  getSheetByName(name) {
    return this.sheets.find((s) => s.name === name) || null;
  }
  insertSheet(name) {
    const sheet = new MockSheet(this, name);
    this.sheets.push(sheet);
    return sheet;
  }
  setSpreadsheetTimeZone(tz) {
    this.timeZone = tz;
  }
}

/** LINE / Slack / Claude の API をまねる既定の応答 */
function defaultFetch(state, call) {
  const url = call.url;
  let m;
  if ((m = url.match(/^https:\/\/api\.line\.me\/v2\/bot\/group\/([^/]+)\/member\/([^/]+)$/))) {
    const name = state.lineProfiles[m[2]];
    return name ? { code: 200, body: { userId: m[2], displayName: name } } : { code: 404, body: { message: 'Not found' } };
  }
  if ((m = url.match(/^https:\/\/api\.line\.me\/v2\/bot\/group\/([^/]+)\/summary$/))) {
    return { code: 200, body: { groupId: m[1], groupName: state.groupNames[m[1]] || 'テストグループ' } };
  }
  if (url === 'https://slack.com/api/chat.postMessage') {
    state.slackSeq += 1;
    return { code: 200, body: { ok: true, channel: 'D0SLACKDM', ts: '1700000000.' + String(state.slackSeq).padStart(6, '0') } };
  }
  if (url === 'https://slack.com/api/chat.update') {
    return { code: 200, body: { ok: true } };
  }
  if (url.startsWith('https://hooks.slack.com/')) {
    return { code: 200, body: 'ok' };
  }
  if (url === 'https://api.anthropic.com/v1/messages') {
    return {
      code: 200,
      body: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: '*🔄 変更点*\n• 清掃は10時→11時に変更（佐藤）' },
        ],
        stop_reason: 'end_turn',
      },
    };
  }
  throw new Error('想定外の URL: ' + url);
}

function createEnv(options = {}) {
  const state = {
    props: Object.assign({}, options.props),
    cache: new Map(),
    spreadsheets: new Map(),
    activeSpreadsheetId: null,
    triggers: [],
    triggerSeq: 0,
    fetches: [],
    slackSeq: 0,
    lineProfiles: Object.assign({}, options.lineProfiles),
    groupNames: Object.assign({}, options.groupNames),
    fetchOverride: null, // (call) => 応答 | undefined（undefined なら既定の応答）
    now: options.now || Date.UTC(2026, 9, 1, 3, 0), // 2026-10-01 12:00 JST
    config: Object.assign({}, options.config),
    logs: [],
  };

  function makeGlobals() {
    const scriptProperties = {
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(state.props, k) ? state.props[k] : null),
      setProperty(k, v) {
        state.props[k] = String(v);
        return scriptProperties;
      },
      getProperties: () => Object.assign({}, state.props),
      deleteProperty(k) {
        delete state.props[k];
        return scriptProperties;
      },
    };
    const log = (level) => (...args) => state.logs.push({ level, text: args.join(' ') });
    return {
      console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error') },
      PropertiesService: { getScriptProperties: () => scriptProperties },
      CacheService: {
        getScriptCache: () => ({
          get: (k) => (state.cache.has(k) ? state.cache.get(k) : null),
          put: (k, v) => state.cache.set(k, String(v)),
          remove: (k) => state.cache.delete(k),
        }),
      },
      LockService: {
        getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {}, hasLock: () => true }),
      },
      Utilities: { getUuid: () => crypto.randomUUID(), sleep() {} },
      ContentService: { createTextOutput: (text) => ({ getContent: () => text, setMimeType() { return this; } }) },
      SpreadsheetApp: {
        openById(id) {
          const ss = state.spreadsheets.get(id);
          if (!ss) throw new Error('Spreadsheet が見つかりません: ' + id);
          return ss;
        },
        getActiveSpreadsheet: () => (state.activeSpreadsheetId ? state.spreadsheets.get(state.activeSpreadsheetId) : null),
        create(name) {
          const id = 'sheet' + (state.spreadsheets.size + 1);
          const ss = new MockSpreadsheet(id, name);
          state.spreadsheets.set(id, ss);
          return ss;
        },
      },
      ScriptApp: {
        newTrigger(handler) {
          const spec = { handler };
          const builder = {
            timeBased: () => builder,
            atHour(h) {
              spec.atHour = h;
              return builder;
            },
            everyDays(n) {
              spec.everyDays = n;
              return builder;
            },
            inTimezone(tz) {
              spec.timezone = tz;
              return builder;
            },
            at(date) {
              spec.at = date.getTime();
              return builder;
            },
            create() {
              const id = 'trigger' + ++state.triggerSeq;
              const trigger = { id, spec, getHandlerFunction: () => handler, getUniqueId: () => id };
              state.triggers.push(trigger);
              return trigger;
            },
          };
          return builder;
        },
        getProjectTriggers: () => state.triggers.slice(),
        deleteTrigger(trigger) {
          state.triggers = state.triggers.filter((t) => t.id !== trigger.id);
        },
      },
      UrlFetchApp: {
        fetch(url, params = {}) {
          const call = {
            url,
            method: (params.method || 'get').toLowerCase(),
            headers: params.headers || {},
            contentType: params.contentType,
            payload: params.payload,
            json: params.payload && /json/.test(params.contentType || '') ? JSON.parse(params.payload) : null,
          };
          state.fetches.push(call);
          const res = (state.fetchOverride && state.fetchOverride(call)) || defaultFetch(state, call);
          if (res.throws) throw new Error(res.throws);
          const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
          return { getResponseCode: () => res.code, getContentText: () => text };
        },
      },
    };
  }

  /** Apps Script の1回の実行をまねて、新しい環境で関数を呼ぶ */
  function run(fnName, ...args) {
    const context = vm.createContext(makeGlobals());
    vm.runInContext(CODE, context, { filename: 'Code.gs' });
    context.__now = () => state.now;
    context.__config = state.config;
    vm.runInContext('now_ = function () { return new Date(__now()); }; Object.assign(CONFIG, __config);', context);
    return context[fnName](...args);
  }

  return {
    state,
    run,
    /** LINE からの Webhook を送る */
    post(events, key) {
      return run('doPost', {
        parameter: { key: key === undefined ? state.props.WEBHOOK_KEY : key },
        postData: { contents: JSON.stringify({ destination: 'U' + '0'.repeat(32), events }) },
      });
    },
    sheet() {
      const ss = state.spreadsheets.get(state.props.SPREADSHEET_ID);
      return ss && ss.getSheetByName('トーク履歴');
    },
    /** 記録シートの行を {列名: 値} の配列で返す */
    records() {
      const sheet = this.sheet();
      if (!sheet) return [];
      const [header, ...rows] = sheet.rows.slice(0, sheet.getLastRow());
      return rows.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] === undefined ? '' : row[i]])));
    },
    fetchesTo(prefix) {
      return state.fetches.filter((c) => c.url.startsWith(prefix));
    },
    slackPosts() {
      return state.fetches.filter((c) => c.url === 'https://slack.com/api/chat.postMessage').map((c) => c.json);
    },
  };
}

module.exports = { createEnv };
