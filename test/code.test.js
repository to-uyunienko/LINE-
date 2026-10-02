'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./gas-env');

const KEY = 'testkey123';
const GROUP = 'C' + 'a'.repeat(32);
const OTHER_GROUP = 'C' + 'b'.repeat(32);
const ME = 'U' + '1'.repeat(32);
const SATO = 'U' + '2'.repeat(32);
const TANAKA = 'U' + '3'.repeat(32);

/** 日本時間の 2026/10/(day) hh:mm を UNIX ミリ秒で */
const jst = (day, hh, mm = 0) => Date.UTC(2026, 9, day, hh - 9, mm);

let seq = 0;
function messageEvent(message, opts = {}) {
  seq += 1;
  return {
    type: 'message',
    mode: 'active',
    timestamp: opts.ts || jst(1, 12),
    webhookEventId: opts.eventId || 'EVT' + seq,
    deliveryContext: { isRedelivery: false },
    source: { type: 'group', groupId: opts.groupId || GROUP, userId: opts.userId === undefined ? SATO : opts.userId },
    replyToken: 'reply' + seq,
    message: Object.assign({ id: String(468789577898262530n + BigInt(seq)), quoteToken: 'q' }, message),
  };
}
const text = (body, opts = {}) => messageEvent(Object.assign({ type: 'text', text: body }, opts.message), opts);

function newEnv(options = {}) {
  const env = createEnv({
    props: Object.assign(
      {
        WEBHOOK_KEY: KEY,
        LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
        MY_LINE_USER_ID: ME,
        SLACK_BOT_TOKEN: 'xoxb-test',
        SLACK_USER_ID: 'U0SLACKME',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
      options.props
    ),
    lineProfiles: Object.assign({ [ME]: 'ゆうま', [SATO]: '佐藤', [TANAKA]: '田中' }, options.lineProfiles),
    groupNames: { [GROUP]: '事業グループ', [OTHER_GROUP]: '別グループ' },
    config: options.config,
    now: options.now,
  });
  env.run('setup');
  env.state.fetches.length = 0;
  return env;
}

// ---------- Webhook ----------

test('key が違うリクエストは無視する', () => {
  const env = newEnv();
  env.post([text('こんにちは')], 'wrong');
  env.post([text('こんにちは')], '');
  env.run('doPost', { parameter: {}, postData: { contents: JSON.stringify({ events: [text('x')] }) } });
  assert.equal(env.records().length, 0);
  assert.equal(env.state.fetches.length, 0);
});

test('LINE の「検証」ボタン（イベントが空）でもエラーにならず、何も返さない', () => {
  const env = newEnv();
  const result = env.post([]);
  assert.equal(result, undefined); // 値を返すと 302 になるため
  assert.equal(env.records().length, 0);
});

test('発言を送信者名つきで記録し、長いメッセージIDも壊さない', () => {
  const env = newEnv();
  const event = text('明日の清掃は10時からです');
  env.post([event]);
  const [row] = env.records();
  assert.equal(row['送信者'], '佐藤');
  assert.equal(row['内容'], '明日の清掃は10時からです');
  assert.equal(row['種類'], 'テキスト');
  assert.equal(row['グループ'], '事業グループ');
  assert.equal(row['メッセージID'], event.message.id);
  assert.equal(typeof row['メッセージID'], 'string');
  assert.equal(row['日時'], '2026/10/01 12:00:00');
  assert.equal(row['タイムスタンプ(ms)'], jst(1, 12));
  assert.equal(row['自分宛'], '');
  assert.equal(env.slackPosts().length, 0);
});

test('数式のような文字列もそのまま文字として記録する', () => {
  const env = newEnv();
  env.post([text('=IMPORTXML("http://example.com")'), text('+81 90-1234-5678')]);
  assert.deepEqual(env.records().map((r) => r['内容']), ['=IMPORTXML("http://example.com")', '+81 90-1234-5678']);
});

test('@メンション（ユーザーID一致）で Slack の自分宛 DM に通知する', () => {
  const env = newEnv();
  env.post([
    text('@ゆうま 請求書の確認お願いします', {
      message: { mention: { mentionees: [{ index: 0, length: 4, type: 'user', userId: ME, isSelf: false }] } },
    }),
  ]);
  const posts = env.slackPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'U0SLACKME');
  assert.match(posts[0].text, /@yuma 宛のメッセージ/);
  assert.match(posts[0].text, /事業グループ｜佐藤｜10\/1\(木\) 12:00/);
  assert.match(posts[0].text, /^> @ゆうま 請求書の確認お願いします$/m);
  assert.equal(env.fetchesTo('https://slack.com/api/chat.postMessage')[0].headers.Authorization, 'Bearer xoxb-test');
  const [row] = env.records();
  assert.equal(row['自分宛'], 'メンション');
  assert.equal(row['Slack通知'], 'D0SLACKDM|1700000000.000001');
});

test('キーワード（全角・大文字でも）で通知する', () => {
  const env = newEnv();
  env.post([text('＠ＹＵＭＡ　明日の件どうしますか？')]);
  assert.equal(env.slackPosts().length, 1);
  assert.equal(env.records()[0]['自分宛'], 'キーワード');
});

test('メンションに userId が無くても（プロフィール未同意）、LINE の表示名で判定する', () => {
  const env = newEnv({ lineProfiles: { [ME]: '伊藤 太郎' } });
  env.post([
    text('@伊藤 太郎 鍵の場所を教えてください', {
      message: { mention: { mentionees: [{ index: 0, length: 6, type: 'user', isSelf: false }] } },
    }),
  ]);
  assert.equal(env.slackPosts().length, 1);
});

test('自分の発言・関係ない発言・他人へのメンションは通知しない', () => {
  const env = newEnv();
  env.post([
    text('@yuma 自分で自分にメモ', { userId: ME }),
    text('了解です'),
    text('@田中 よろしく', {
      message: { mention: { mentionees: [{ index: 0, length: 3, type: 'user', userId: TANAKA, isSelf: false }] } },
    }),
  ]);
  assert.equal(env.slackPosts().length, 0);
  assert.equal(env.records().length, 3);
});

test('自分の発言へのリプライ（引用返信）も通知する', () => {
  const env = newEnv();
  const mine = text('ゴミ出しは誰がやりますか？', { userId: ME });
  env.post([mine]);
  env.post([text('私がやります', { message: { quotedMessageId: mine.message.id } })]);
  const posts = env.slackPosts();
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /あなたの発言に返信がありました/);
  assert.match(posts[0].text, /返信先: ゴミ出しは誰がやりますか？/);
  assert.equal(env.records()[1]['自分宛'], '返信');
});

test('NOTIFY_REPLY_TO_ME=false なら他人へのリプライは通知しない', () => {
  const env = newEnv({ config: { NOTIFY_REPLY_TO_ME: false } });
  const mine = text('質問です', { userId: ME });
  env.post([mine]);
  env.post([text('回答です', { message: { quotedMessageId: mine.message.id } })]);
  assert.equal(env.slackPosts().length, 0);
});

test('@All は NOTIFY_MENTION_ALL が true のときだけ通知する', () => {
  const all = () => text('@All 明日は休業です', { message: { mention: { mentionees: [{ index: 0, length: 4, type: 'all' }] } } });
  const off = newEnv();
  off.post([all()]);
  assert.equal(off.slackPosts().length, 0);

  const on = newEnv({ config: { NOTIFY_MENTION_ALL: true } });
  on.post([all()]);
  assert.equal(on.slackPosts().length, 1);
  assert.equal(on.records()[0]['自分宛'], '@All');
});

test('同じイベントが再送されても1回だけ処理する', () => {
  const env = newEnv();
  const event = text('@yuma 至急お願いします', { eventId: 'SAME' });
  env.post([event]);
  env.post([event]);
  assert.equal(env.records().length, 1);
  assert.equal(env.slackPosts().length, 1);
});

test('TARGET_GROUP_ID を設定すると他のグループと1対1トークは無視する', () => {
  const env = newEnv({ props: { TARGET_GROUP_ID: GROUP } });
  const direct = text('@yuma 個別トーク');
  direct.source = { type: 'user', userId: SATO };
  env.post([text('@yuma 別グループ', { groupId: OTHER_GROUP }), direct, text('対象グループ')]);
  assert.deepEqual(env.records().map((r) => r['内容']), ['対象グループ']);
  assert.equal(env.slackPosts().length, 0);
});

test('PC 版などでユーザーIDが無い発言も「不明」として記録する', () => {
  const env = newEnv();
  env.post([text('PCから送信', { userId: null })]);
  assert.equal(env.records()[0]['送信者'], '不明');
});

test('画像・スタンプ・ファイル・位置情報も内容が分かる形で記録する', () => {
  const env = newEnv();
  env.post([
    messageEvent({ type: 'image', imageSet: { id: 'set', index: 1, total: 3 }, contentProvider: { type: 'line' } }),
    messageEvent({ type: 'sticker', packageId: '1', stickerId: '2', stickerResourceType: 'STATIC', keywords: ['OK', 'Thanks', 'Yes'] }),
    messageEvent({ type: 'file', fileName: '見積書.pdf', fileSize: 1000 }),
    messageEvent({ type: 'location', title: '渋谷駅', address: '東京都渋谷区', latitude: 0, longitude: 0 }),
  ]);
  assert.deepEqual(env.records().map((r) => r['内容']), [
    '[画像 1/3]',
    '[スタンプ: OK, Thanks]',
    '[ファイル: 見積書.pdf]',
    '[位置情報: 渋谷駅 東京都渋谷区]',
  ]);
});

test('メンバーの参加・退出を記録する（退出した人は記録に残っている名前を使う）', () => {
  const env = newEnv();
  env.post([text('こんにちは', { userId: TANAKA })]);
  env.state.cache.clear();
  delete env.state.lineProfiles[TANAKA]; // 退出後はプロフィールを取得できない
  const base = { mode: 'active', deliveryContext: { isRedelivery: false }, source: { type: 'group', groupId: GROUP } };
  env.post([
    Object.assign({ type: 'memberJoined', timestamp: jst(1, 13), webhookEventId: 'J1', joined: { members: [{ type: 'user', userId: SATO }] } }, base),
    Object.assign({ type: 'memberLeft', timestamp: jst(1, 14), webhookEventId: 'L1', left: { members: [{ type: 'user', userId: TANAKA }] } }, base),
  ]);
  assert.deepEqual(env.records().slice(1).map((r) => [r['種類'], r['内容']]), [
    ['参加', '佐藤 が参加しました'],
    ['退出', '田中 が退出しました'],
  ]);
});

test('送信取消されたら記録の内容を消し、Slack の通知も書き換える', () => {
  const env = newEnv();
  const event = text('@yuma 間違えて送りました');
  env.post([event]);
  env.post([
    { type: 'unsend', mode: 'active', timestamp: jst(1, 12, 1), webhookEventId: 'U1', deliveryContext: { isRedelivery: false },
      source: { type: 'group', groupId: GROUP, userId: SATO }, unsend: { messageId: event.message.id } },
  ]);
  const [row] = env.records();
  assert.equal(row['内容'], '');
  assert.equal(row['状態'], '送信取消');
  const updates = env.fetchesTo('https://slack.com/api/chat.update');
  assert.equal(updates.length, 1);
  assert.deepEqual(
    { channel: updates[0].json.channel, ts: updates[0].json.ts },
    { channel: 'D0SLACKDM', ts: '1700000000.000001' }
  );
  assert.match(updates[0].json.text, /送信取消/);
});

test('編集されたら内容を更新して編集前も残し、順番が前後した古い編集は無視する', () => {
  const env = newEnv();
  const original = text('@yuma 清掃は10時からです', { ts: jst(1, 9) });
  env.post([original]);
  const edit = (body, ts, eventId) => ({
    type: 'messageEdited', mode: 'active', timestamp: ts, webhookEventId: eventId, deliveryContext: { isRedelivery: false },
    source: { type: 'group', groupId: GROUP, userId: SATO }, replyToken: 'r',
    message: { type: 'text', id: original.message.id, text: body, quoteToken: 'q' },
  });
  env.post([edit('@yuma 清掃は11時からです', jst(1, 9, 30), 'E2')]);
  env.post([edit('@yuma 清掃は10時半からです', jst(1, 9, 10), 'E1')]); // 遅れて届いた古い編集

  const [row] = env.records();
  assert.equal(row['内容'], '@yuma 清掃は11時からです');
  assert.equal(row['編集前の内容'], '@yuma 清掃は10時からです');
  assert.equal(row['状態'], '編集済み');
  assert.equal(row['日時'], '2026/10/01 09:00:00'); // 日時は元の送信時刻のまま
  assert.equal(env.slackPosts().length, 1); // 通知は増やさない
  const updates = env.fetchesTo('https://slack.com/api/chat.update');
  assert.equal(updates.length, 1);
  assert.match(updates[0].json.text, /清掃は11時からです/);
  assert.match(updates[0].json.text, /編集されました/);
});

test('編集でメンションが追加されたら、そのとき通知する', () => {
  const env = newEnv();
  const original = text('確認お願いします');
  env.post([original]);
  env.post([
    { type: 'messageEdited', mode: 'active', timestamp: jst(1, 12, 5), webhookEventId: 'E9', deliveryContext: { isRedelivery: false },
      source: { type: 'group', groupId: GROUP, userId: SATO }, replyToken: 'r',
      message: { type: 'text', id: original.message.id, text: '@yuma 確認お願いします', quoteToken: 'q' } },
  ]);
  const posts = env.slackPosts();
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /編集で追加されました/);
  assert.equal(env.records()[0]['自分宛'], 'キーワード');
});

test('Slack への送信に失敗しても発言は記録する', () => {
  const env = newEnv();
  env.state.fetchOverride = (call) =>
    call.url.includes('chat.postMessage') ? { code: 200, body: { ok: false, error: 'channel_not_found' } } : undefined;
  env.post([text('@yuma テスト')]);
  assert.equal(env.records().length, 1);
  assert.equal(env.records()[0]['Slack通知'], '');
  assert.ok(env.state.logs.some((l) => l.level === 'error' && /channel_not_found/.test(l.text)));
});

test('Incoming Webhook でも通知でき、自分をメンションする', () => {
  const env = newEnv({ props: { SLACK_BOT_TOKEN: '', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' } });
  env.post([text('@yuma 見ておいてください')]);
  const calls = env.fetchesTo('https://hooks.slack.com/');
  assert.equal(calls.length, 1);
  assert.match(calls[0].json.text, /^<@U0SLACKME> 🔔/);
});

test('Slack の特殊文字（< > &）をエスケープする', () => {
  const env = newEnv();
  env.post([text('@yuma <!channel> A&B')]);
  assert.match(env.slackPosts()[0].text, /&lt;!channel&gt; A&amp;B/);
});

// ---------- 毎朝の要約 ----------

/** 2026/10/1 の発言をいくつか記録しておく */
function seedDay(env) {
  const posts = [
    text('前々日の発言', { ts: jst(0, 23) }), // 9/30 23:00 → 対象外
    text('早朝の発言', { ts: jst(1, 7, 59) }), // 対象外
    text('清掃は10時からでお願いします', { ts: jst(1, 8) }),
    text('取り消す発言', { ts: jst(1, 9) }),
    text('@yuma 請求書を確認してください', { ts: jst(1, 10), userId: TANAKA }),
    text('確認します', { ts: jst(1, 11), userId: ME }),
    text('夜の発言', { ts: jst(1, 21, 59) }),
    text('22時の発言', { ts: jst(1, 22) }), // 対象外
    text('今日の発言', { ts: jst(2, 6) }), // 対象外
  ];
  env.post(posts);
  env.post([
    { type: 'unsend', mode: 'active', timestamp: jst(1, 9, 1), webhookEventId: 'UNSEND', deliveryContext: { isRedelivery: false },
      source: { type: 'group', groupId: GROUP, userId: SATO }, unsend: { messageId: posts[3].message.id } },
  ]);
  env.state.fetches.length = 0;
}

test('前日 8:00〜22:00 の発言だけを Claude で要約して Slack に送る（1日1回）', () => {
  const env = newEnv();
  seedDay(env);
  env.state.now = jst(2, 7);
  env.run('sendDailySummary');

  const claude = env.fetchesTo('https://api.anthropic.com/');
  assert.equal(claude.length, 1);
  assert.equal(claude[0].headers['x-api-key'], 'sk-ant-test');
  assert.equal(claude[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(claude[0].headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  const body = claude[0].json;
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.thinking, undefined);
  assert.match(body.system, /変更点/);
  const prompt = body.messages[0].content;
  assert.match(prompt, /\[08:00\] 佐藤: 清掃は10時からでお願いします/);
  assert.match(prompt, /\[10:00\] ★田中: @yuma 請求書を確認してください/);
  assert.match(prompt, /\[11:00\] ゆうま（yuma本人）: 確認します/);
  assert.match(prompt, /\[21:59\] 佐藤: 夜の発言/);
  for (const excluded of ['前々日', '早朝', '取り消す', '22時', '今日の']) assert.doesNotMatch(prompt, new RegExp(excluded));

  const posts = env.slackPosts();
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /^📋 \*事業グループ\* 10\/1\(木\) 8:00〜22:00 のまとめ（4件）/);
  assert.match(posts[0].text, /清掃は10時→11時に変更/);
  assert.equal(env.state.props.LAST_SUMMARY_DATE, '2026-10-01');

  env.run('sendDailySummary'); // 2回目は送らない
  assert.equal(env.slackPosts().length, 1);
});

test('要約には編集前の内容と、リプライ先が分かる形で渡す', () => {
  const env = newEnv();
  const first = text('チェックインは15時です', { ts: jst(1, 9) });
  env.post([first]);
  env.post([
    { type: 'messageEdited', mode: 'active', timestamp: jst(1, 9, 5), webhookEventId: 'EDIT', deliveryContext: { isRedelivery: false },
      source: { type: 'group', groupId: GROUP, userId: SATO }, replyToken: 'r',
      message: { type: 'text', id: first.message.id, text: 'チェックインは16時です', quoteToken: 'q' } },
  ]);
  env.post([text('了解です', { ts: jst(1, 9, 10), userId: TANAKA, message: { quotedMessageId: first.message.id } })]);
  env.state.now = jst(2, 7);
  env.run('sendDailySummary');
  const prompt = env.fetchesTo('https://api.anthropic.com/')[0].json.messages[0].content;
  assert.match(prompt, /チェックインは16時です\n {4}（編集済み。編集前: チェックインは15時です）/);
  assert.match(prompt, /田中: （佐藤「チェックインは16時です」への返信）了解です/);
});

test('Claude の呼び出しに失敗したら、エラー内容と発言一覧を送る', () => {
  const env = newEnv();
  seedDay(env);
  env.state.fetchOverride = (call) =>
    call.url.startsWith('https://api.anthropic.com/') ? { code: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } } : undefined;
  env.state.now = jst(2, 7);
  env.run('sendDailySummary');
  assert.equal(env.fetchesTo('https://api.anthropic.com/').length, 1); // 401 は再試行しない
  const post = env.slackPosts()[0].text;
  assert.match(post, /AI要約ができなかったため、発言一覧を送ります（Claude API エラー 401/);
  assert.match(post, /08:00 佐藤: 清掃は10時からでお願いします/);
  assert.match(post, /10:00 ★田中: @yuma 請求書を確認してください/);
});

test('Claude が混雑（529）なら再試行する', () => {
  const env = newEnv();
  seedDay(env);
  let calls = 0;
  env.state.fetchOverride = (call) => {
    if (!call.url.startsWith('https://api.anthropic.com/')) return undefined;
    calls += 1;
    return calls === 1 ? { code: 529, body: { type: 'error', error: { type: 'overloaded_error' } } } : undefined;
  };
  env.state.now = jst(2, 7);
  env.run('sendDailySummary');
  assert.equal(calls, 2);
  assert.match(env.slackPosts()[0].text, /清掃は10時→11時に変更/);
});

test('API キーが未設定なら発言一覧を送る', () => {
  const env = newEnv({ props: { ANTHROPIC_API_KEY: '' } });
  seedDay(env);
  env.state.now = jst(2, 7);
  env.run('sendDailySummary');
  assert.equal(env.fetchesTo('https://api.anthropic.com/').length, 0);
  assert.match(env.slackPosts()[0].text, /ANTHROPIC_API_KEY が未設定です/);
});

test('発言がなかった日は「発言はありませんでした」と送る', () => {
  const env = newEnv();
  env.state.now = jst(2, 7);
  env.run('sendDailySummary');
  assert.equal(env.slackPosts()[0].text, '📋 10/1(木) 8:00〜22:00 のLINEグループの発言はありませんでした');
});

test('長い要約は Slack の1メッセージに収まるよう分けて送る', () => {
  const env = newEnv();
  seedDay(env);
  const long = Array.from({ length: 200 }, (_, i) => '• 項目' + i + ' ' + 'あ'.repeat(30)).join('\n');
  env.state.fetchOverride = (call) =>
    call.url.startsWith('https://api.anthropic.com/') ? { code: 200, body: { content: [{ type: 'text', text: long }], stop_reason: 'end_turn' } } : undefined;
  env.state.now = jst(2, 7);
  env.run('sendDailySummary');
  const posts = env.slackPosts();
  assert.ok(posts.length >= 2);
  for (const p of posts) assert.ok(p.text.length <= 3500);
  assert.equal(posts.map((p) => p.text).join('\n').split('\n').filter((l) => l.startsWith('• 項目')).length, 200);
});

test('testSummaryToday は今日の 8:00〜現在までを要約する', () => {
  const env = newEnv();
  env.post([text('朝の連絡', { ts: jst(2, 8, 30) }), text('昼の連絡', { ts: jst(2, 12) })]);
  env.state.fetches.length = 0;
  env.state.now = jst(2, 10);
  env.run('testSummaryToday');
  const prompt = env.fetchesTo('https://api.anthropic.com/')[0].json.messages[0].content;
  assert.match(prompt, /朝の連絡/);
  assert.doesNotMatch(prompt, /昼の連絡/);
  assert.match(env.slackPosts()[0].text, /10\/2\(金\) 8:00〜10:00 のまとめ（1件）/);
  assert.equal(env.state.props.LAST_SUMMARY_DATE, undefined);
});

// ---------- トリガー ----------

test('setup は記録シート・キー・毎日6時台のトリガーを用意する（何度実行しても1つ）', () => {
  const env = createEnv({ props: {} });
  env.run('setup');
  env.run('setup');
  assert.match(env.state.props.WEBHOOK_KEY, /^[0-9a-f]{32}$/);
  const ss = env.state.spreadsheets.get(env.state.props.SPREADSHEET_ID);
  assert.equal(ss.timeZone, 'Asia/Tokyo');
  assert.equal(ss.getSheetByName('トーク履歴').rows[0][0], '日時');
  assert.equal(env.state.triggers.length, 1);
  assert.deepEqual(env.state.triggers[0].spec, {
    handler: 'prepareDailySummary', atHour: 6, everyDays: 1, timezone: 'Asia/Tokyo',
  });
  assert.ok(env.state.logs.some((l) => /\?key=/.test(l.text)));
});

test('prepareDailySummary は 7:00 ちょうどに1回きりのトリガーを予約する', () => {
  const env = newEnv({ now: jst(2, 6, 12) });
  env.run('prepareDailySummary');
  env.run('prepareDailySummary'); // 二重に予約しない
  const oneShot = env.state.triggers.filter((t) => t.spec.handler === 'sendDailySummary');
  assert.equal(oneShot.length, 1);
  assert.equal(oneShot[0].spec.at, jst(2, 7));
  assert.equal(env.slackPosts().length, 0);

  env.state.now = jst(2, 7);
  env.run('sendDailySummary');
  assert.equal(env.state.triggers.filter((t) => t.spec.handler === 'sendDailySummary').length, 0); // 使用後は削除
  assert.equal(env.slackPosts().length, 1);
});

test('prepareDailySummary が 7:00 を過ぎて動いたら、すぐに送る', () => {
  const env = newEnv({ now: jst(2, 7, 0) + 30 * 1000 });
  env.run('prepareDailySummary');
  assert.equal(env.state.triggers.filter((t) => t.spec.handler === 'sendDailySummary').length, 0);
  assert.equal(env.slackPosts().length, 1);
});

test('保存期間を過ぎた記録は要約のあとに削除する', () => {
  const env = newEnv();
  env.post([text('古い発言', { ts: jst(1, 12) - 100 * 86400000 }), text('新しい発言', { ts: jst(1, 12) })]);
  env.state.now = jst(2, 7);
  env.run('sendDailySummary');
  assert.deepEqual(env.records().map((r) => r['内容']), ['新しい発言']);

  // すべて古い場合も（見出し以外の全行は削除できない仕様に当たらず）消せる
  env.state.now = jst(2, 7) + 200 * 86400000;
  env.state.props.LAST_SUMMARY_DATE = '';
  env.run('sendDailySummary');
  assert.equal(env.records().length, 0);
  env.post([text('その後の発言', { ts: env.state.now })]);
  assert.deepEqual(env.records().map((r) => r['内容']), ['その後の発言']);
});
