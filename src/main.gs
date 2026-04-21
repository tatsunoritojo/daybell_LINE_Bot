// ==========================================
// 設定情報（すべて Script Properties から読み込む）
// ==========================================
// 初回は setup() を1度だけ実行してプロパティ雛形を作り、
// スクリプトエディタ → プロジェクトの設定 → スクリプトプロパティ で各値を設定する。
// コード埋め込みをやめたことで、コードを差し替えても秘匿値が吹き飛ばない

const PROPS = PropertiesService.getScriptProperties();
const LINE_ACCESS_TOKEN = PROPS.getProperty('LINE_ACCESS_TOKEN');
const LINE_USER_ID = PROPS.getProperty('LINE_USER_ID');
const WEATHER_AREA_CODE = PROPS.getProperty('WEATHER_AREA_CODE') || '130000';
const WEATHER_AREA_LABEL = PROPS.getProperty('WEATHER_AREA_LABEL') || '東京';

// 対象カレンダー: TARGET_CALENDAR_ID が設定されていればそれを、空なら主カレンダーを返す
function getTargetCalendar() {
  const id = PROPS.getProperty('TARGET_CALENDAR_ID');
  return id ? CalendarApp.getCalendarById(id) : getTargetCalendar();
}

// 初回セットアップ: 必要なプロパティキーの雛形を作成する。
// 既に値が入っているキーは上書きしない
function setup() {
  const defaults = {
    'LINE_ACCESS_TOKEN': '',
    'LINE_USER_ID': '',
    'TARGET_CALENDAR_ID': '',
    'WEATHER_AREA_CODE': '130000',
    'WEATHER_AREA_LABEL': '東京'
  };
  for (const key in defaults) {
    if (PROPS.getProperty(key) === null) PROPS.setProperty(key, defaults[key]);
  }
  Logger.log([
    'セットアップ完了。',
    'スクリプトエディタ → プロジェクトの設定 → スクリプトプロパティ で以下を設定してください:',
    '  LINE_ACCESS_TOKEN    — LINE Developers のチャネルアクセストークン（長期）',
    '  LINE_USER_ID         — あなた自身の LINE ユーザーID (U... で始まる)',
    '  TARGET_CALENDAR_ID   — 対象カレンダーID（空にすると主カレンダー）',
    '  WEATHER_AREA_CODE    — 気象庁エリアコード（デフォルト 130000 = 東京）',
    '  WEATHER_AREA_LABEL   — 天気予報の表示ラベル（デフォルト 東京）'
  ].join('\n'));
}

// ==========================================
// LINE Webhook処理
// ==========================================
//
// タスク登録フローは3段階（開始時刻 → 終了時刻 → 目標/タスク確定）の対話。
// 各段階の状態はセッション（PropertiesService）で管理し、古いボタンの再タップや
// 別フローからの割り込みによる二重登録を防ぐ。
// セッションと齟齬するポストバックは全て無視される。

function doPost(e) {
  try {
    const events = JSON.parse(e.postData.contents).events;
    if (!events || events.length === 0) return;

    // LINEは1つのWebhookに複数イベントを詰めて送ることがある（検証Webhook・再送等）。
    // イベントごとに独立して処理し、1件のエラーで以降を止めないようtry/catchで囲む
    for (let i = 0; i < events.length; i++) {
      try {
        handleWebhookEvent(events[i]);
      } catch (err) {
        console.error('event handler error: ' + (err && err.message ? err.message : err));
      }
    }
  } catch (err) {
    console.error('doPost error: ' + (err && err.message ? err.message : err));
  }
}

function handleWebhookEvent(event) {
  // 送信元ユーザーIDチェック
  const sourceUserId = event.source && event.source.userId;
  if (sourceUserId !== LINE_USER_ID) {
    console.log('Rejected unauthorized userId: ' + sourceUserId);
    return;
  }

  const replyToken = event.replyToken;

  // --- A. メッセージ受信時の処理 ---
  if (event.type === 'message') {
    // テキスト以外（画像・スタンプ・位置情報等）は対応外として案内を返す
    if (event.message.type !== 'text') {
      if (replyToken) replyLineMessage(replyToken, 'テキストメッセージで送ってください。');
      return;
    }
    const userMessage = event.message.text;

    if (userMessage === '目標設定') {
      clearTaskSession();
      showGoalSelection(replyToken);
    }
    else if (userMessage === '予定確認') {
      clearTaskSession();
      replyUpcomingWeekSchedule(replyToken);
    }
    else if (userMessage.startsWith('これを目標にする：')) {
      handleGoalConfirmation(replyToken, userMessage);
    }
    else {
      // タスク登録フロー開始。flowId + stepToken を発行してボタンに埋め込む。
      // 既存セッションは新メッセージで上書きされ、古いボタンはtoken不一致で弾かれる
      const flowId = generateToken();
      const stepToken = generateToken();
      setTaskSession({
        step: 'awaitingStart',
        taskName: userMessage,
        flowId: flowId,
        stepToken: stepToken
      });
      sendStartDateTimePicker(replyToken, userMessage, flowId, stepToken);
    }
  }

  // --- B. ポストバック（GUI操作）受信時の処理 ---
  else if (event.type === 'postback') {
    const data = event.postback.data;
    const params = data.split('&').reduce((acc, cur) => {
      const [key, val] = cur.split('=');
      acc[key] = val;
      return acc;
    }, {});

    // 排他制御: 同時連打・再試行による状態競合を防ぐ
    const lock = LockService.getScriptLock();
    let acquired = false;
    try {
      acquired = lock.tryLock(10000);
      if (!acquired) {
        console.log('Could not acquire lock within 10s, skipping postback. action=' + params.action);
        return;
      }

      // 消費済みトークン（= 既に押されたボタン）は二重処理しない
      if (params.token && isTokenConsumed(params.token)) {
        console.log('Token already consumed: ' + params.token);
        if (replyToken) replyLineMessage(replyToken, 'このボタンはすでに処理済みです。最初からやり直してください。');
        return;
      }

      const session = getTaskSession();
      if (!session) {
        console.log('Ignoring postback: no active session. action=' + params.action);
        if (replyToken) replyLineMessage(replyToken, 'タスク登録フローの有効期限が切れました。最初からタスク名を送ってください。');
        return;
      }

      // セッションとのトークン整合性チェック（flowId + stepToken 両方一致する必要あり）
      if (!params.token || session.flowId !== params.flowId || session.stepToken !== params.token) {
        console.log('Token mismatch. action=' + params.action + ', session.step=' + session.step);
        if (replyToken) replyLineMessage(replyToken, 'このボタンは期限切れです。最新のフローを進めてください。');
        return;
      }

      if (params.action === 'setStart' && session.step === 'awaitingStart') {
        consumeToken(params.token);
        const startTime = event.postback.params.datetime;
        const nextToken = generateToken();
        setTaskSession({
          step: 'awaitingEnd',
          taskName: session.taskName,
          startTime: startTime,
          flowId: session.flowId,
          stepToken: nextToken
        });
        sendEndDateTimePicker(replyToken, session.taskName, startTime, session.flowId, nextToken);
      }
      else if (params.action === 'setEnd' && session.step === 'awaitingEnd') {
        consumeToken(params.token);
        const endTime = event.postback.params.datetime;
        const nextToken = generateToken();
        setTaskSession({
          step: 'awaitingConfirm',
          taskName: session.taskName,
          startTime: session.startTime,
          endTime: endTime,
          flowId: session.flowId,
          stepToken: nextToken
        });
        sendFinalGoalConfirm(replyToken, session.flowId, nextToken);
      }
      else if (params.action === 'finalRegister' && session.step === 'awaitingConfirm') {
        consumeToken(params.token);
        const isGoal = params.isGoal === 'true';
        // 登録前にセッションをクリア。後続の二重発火は session=null で弾かれる
        clearTaskSession();
        executeFinalRegistration(replyToken, session.taskName, session.startTime, session.endTime, isGoal);
      }
      else {
        console.log('Ignoring stale/out-of-order postback. action=' + params.action + ', step=' + session.step);
        if (replyToken) replyLineMessage(replyToken, '操作の順序が一致しません。最初からやり直してください。');
      }
    } finally {
      if (acquired) {
        try { lock.releaseLock(); } catch (e) { /* ignore */ }
      }
    }
  }
  // 他のイベントタイプ（follow / unfollow / join / leave 等）は単に無視する
}

// タスク登録フローのセッション管理（PropertiesServiceで永続化）
// session: { step, taskName, startTime?, endTime?, flowId, stepToken }
// - flowId: フロー全体を識別するID（新規メッセージで再発行）
// - stepToken: ステップ毎に発行する one-time トークン（ボタン1個に1個）
const TASK_SESSION_KEY = 'task_session';

function getTaskSession() {
  const raw = PropertiesService.getScriptProperties().getProperty(TASK_SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function setTaskSession(session) {
  PropertiesService.getScriptProperties().setProperty(TASK_SESSION_KEY, JSON.stringify(session));
}

function clearTaskSession() {
  PropertiesService.getScriptProperties().deleteProperty(TASK_SESSION_KEY);
}

// UUID の先頭12文字を使った短めのトークン。衝突確率は実用上無視できる
function generateToken() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

// トークンを『使用済み』としてCacheServiceに記録する。TTL 10分で自動消滅。
// CacheService は永続保証がないため補助的な重複検知として使う
//（本線の検証は session.stepToken との一致チェック）
function consumeToken(token) {
  CacheService.getScriptCache().put('used_token:' + token, '1', 600);
}

function isTokenConsumed(token) {
  return CacheService.getScriptCache().get('used_token:' + token) !== null;
}

// ==========================================
// ロジック関数：タスクGUI登録（対話ステップ）
// ==========================================

// ステップ1：開始時間をきく
function sendStartDateTimePicker(replyToken, taskName, flowId, stepToken) {
  sendLinePayload(replyToken, {
    'type': 'template',
    'altText': '開始時間を選択してください',
    'template': {
      'type': 'buttons',
      'text': '「' + taskName + '」の【開始時間】を選んでください。',
      'actions': [{
        'type': 'datetimepicker',
        'label': 'カレンダーを開く',
        'data': 'action=setStart&flowId=' + flowId + '&token=' + stepToken,
        'mode': 'datetime'
      }]
    }
  });
}

// ステップ2：終了時間をきく
function sendEndDateTimePicker(replyToken, taskName, startTime, flowId, stepToken) {
  sendLinePayload(replyToken, {
    'type': 'template',
    'altText': '終了時間を選択してください',
    'template': {
      'type': 'buttons',
      'text': '「' + taskName + '」の【終了時間】を選んでください。',
      'actions': [{
        'type': 'datetimepicker',
        'label': 'カレンダーを開く',
        'data': 'action=setEnd&flowId=' + flowId + '&token=' + stepToken,
        'mode': 'datetime',
        // 開始時刻より前を選べないようにガード
        'min': startTime,
        'initial': startTime
      }]
    }
  });
}

// ステップ3：目標にするか確認する
// はい/いいえ は同じステップの分岐なので stepToken を共有。先にタップされた方が消費し、
// もう一方はトークン消費済み判定で弾かれる（=片方のみ登録）
function sendFinalGoalConfirm(replyToken, flowId, stepToken) {
  sendLinePayload(replyToken, {
    'type': 'template',
    'altText': '目標に設定しますか？',
    'template': {
      'type': 'confirm',
      'text': 'このタスクを「重要目標（カウントダウン対象）」として登録しますか？',
      'actions': [
        { 'type': 'postback', 'label': 'はい', 'data': 'action=finalRegister&isGoal=true&flowId=' + flowId + '&token=' + stepToken },
        { 'type': 'postback', 'label': 'いいえ', 'data': 'action=finalRegister&isGoal=false&flowId=' + flowId + '&token=' + stepToken }
      ]
    }
  });
}

// ステップ4：カレンダーへ書き込み
// 複数日（開始日と終了日が2日以上離れている）の場合は時間指定ではなく終日イベントとして登録する。
// GASの createAllDayEvent(startDate, endDateExclusive) を使うと GCal の上部バーにきれいに収まる
function executeFinalRegistration(replyToken, taskName, startTimeStr, endTimeStr, isGoal) {
  // サーバー側バリデーション（UI側のガードが効かないケースに備える防衛線）
  if (!taskName || taskName.trim().length === 0) {
    replyLineMessage(replyToken, 'タスク名が空です。最初からやり直してください。');
    return;
  }
  if (taskName.length > 200) {
    replyLineMessage(replyToken, 'タスク名が長すぎます（200文字以内）。最初からやり直してください。');
    return;
  }
  const startDt = new Date(startTimeStr);
  const endDt = new Date(endTimeStr);
  if (isNaN(startDt.getTime()) || isNaN(endDt.getTime())) {
    replyLineMessage(replyToken, '日時を解析できませんでした。最初からやり直してください。');
    return;
  }
  if (endDt.getTime() <= startDt.getTime()) {
    replyLineMessage(replyToken, '終了時刻は開始時刻より後に設定してください。最初からやり直してください。');
    return;
  }
  // 既存タイトルに prefix が含まれている場合は剥がしてから付け直す
  const baseTaskName = stripTitlePrefixes(taskName);
  const prefix = isGoal ? '【目標】' : '【タスク】';
  const title = prefix + baseTaskName;
  const calendar = getTargetCalendar();

  // JST基準で日付単位の差を計算
  const startDate = jstMidnight(startDt);
  const endDate = jstMidnight(endDt);
  const dayDiff = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));

  let msg;
  if (dayDiff >= 2) {
    // 2日以上またがる予定は終日イベントに変換（時間の切れ目は失うが上部バーで綺麗に並ぶ）
    const endExclusive = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
    calendar.createAllDayEvent(title, startDate, endExclusive);
    const startStr = Utilities.formatDate(startDate, 'Asia/Tokyo', 'M/d');
    const endStr = Utilities.formatDate(endDate, 'Asia/Tokyo', 'M/d');
    msg = "カレンダーに登録しました（複数日のため終日扱い）。\n日時：" + startStr + '〜' + endStr
      + "\n内容：" + title;
  } else {
    // 単日 or 日またぎ24時間以内は時間指定イベントのまま
    calendar.createEvent(title, startDt, endDt);
    const sameDay = startDt.getFullYear() === endDt.getFullYear()
      && startDt.getMonth() === endDt.getMonth()
      && startDt.getDate() === endDt.getDate();
    const startStr = Utilities.formatDate(startDt, 'Asia/Tokyo', 'M/d HH:mm');
    const endStr = sameDay
      ? Utilities.formatDate(endDt, 'Asia/Tokyo', 'HH:mm')
      : Utilities.formatDate(endDt, 'Asia/Tokyo', 'M/d HH:mm');
    msg = "カレンダーに登録しました。\n日時：" + startStr + '〜' + endStr + "\n内容：" + title;
  }

  if (isGoal) msg += "\n※目標として設定されました。";
  replyLineMessage(replyToken, msg);
}

// スクリプトTZに依らず、与えられたDateをJST基準でその日の0時0分に揃えて返す
function jstMidnight(date) {
  const jstDateStr = Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
  return new Date(jstDateStr + 'T00:00:00+09:00');
}

// ==========================================
// 既存の機能（目標設定メニュー・通知・天気等）
// ==========================================

function showGoalSelection(replyToken) {
  const calendar = getTargetCalendar();
  const now = new Date();
  const halfYearLater = new Date();
  halfYearLater.setMonth(now.getMonth() + 6);
  const events = calendar.getEvents(now, halfYearLater);

  let items = [];
  for (let i = 0; i < Math.min(events.length, 13); i++) {
    const title = events[i].getTitle();
    if (!title.includes('【目標】')) {
      items.push({ "type": "action", "action": { "type": "message", "label": title.substring(0, 20), "text": "これを目標にする：" + title } });
    }
  }
  if (items.length > 0) sendQuickReply(replyToken, "どの予定を目標カウントダウンに設定しますか？", items);
  else replyLineMessage(replyToken, "候補が見つかりませんでした。");
}

function handleGoalConfirmation(replyToken, userMessage) {
  const targetTitle = userMessage.replace('これを目標にする：', '');
  const events = getTargetCalendar().getEvents(new Date(), new Date(new Date().setMonth(new Date().getMonth() + 6)));
  for (let i = 0; i < events.length; i++) {
    if (events[i].getTitle() === targetTitle) {
      // 既に【タスク】や【目標】が付いていたら一度剥がしてから【目標】を付け直す。
      // これを怠ると「【目標】【タスク】○○」のような多重プレフィックスが発生する
      const baseTitle = stripTitlePrefixes(targetTitle);
      events[i].setTitle('【目標】' + baseTitle);
      replyLineMessage(replyToken, "「" + baseTitle + "」を目標に設定しました。");
      return;
    }
  }
  // 一致するイベントが見つからなかった場合に無言で終わらないよう、案内を返す
  replyLineMessage(replyToken, "予定が見つかりませんでした。時間経過で候補外になった可能性があります。もう一度「目標設定」を送ってください。");
}

// タイトル先頭の【目標】/【タスク】を取り除く。どちらも付いていない場合はそのまま返す。
// prefix の多重付与（例: 【目標】【タスク】○○）を防ぐために使う
function stripTitlePrefixes(title) {
  return title.replace(/^【目標】/, '').replace(/^【タスク】/, '');
}

// リッチメニュー「予定確認」から呼ばれる：今日から7日分の予定をFlex Messageで返す
// 各日 getEventsForDay で取得するため、複数日にまたがる予定は該当する各日に出現する（取りこぼしなし）
function replyUpcomingWeekSchedule(replyToken) {
  const calendar = getTargetCalendar();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekDayLabels = ['日', '月', '火', '水', '木', '金', '土'];
  const bodyContents = [];
  let hasAny = false;

  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
    const events = calendar.getEventsForDay(d);
    if (events.length === 0) continue;
    hasAny = true;

    const dateLabel = Utilities.formatDate(d, 'Asia/Tokyo', 'M/d') + '(' + weekDayLabels[d.getDay()] + ')';
    const specialLabel = i === 0 ? ' 今日' : i === 1 ? ' 明日' : '';
    const headerColor = i === 0 ? '#D97706' : '#3D2510';

    bodyContents.push({
      "type": "box",
      "layout": "vertical",
      "margin": i === 0 ? "none" : "lg",
      "contents": [
        { "type": "text", "text": dateLabel + specialLabel, "weight": "bold", "size": "md", "color": headerColor },
        { "type": "separator", "margin": "xs", "color": "#D9CDB0" }
      ]
    });

    for (let j = 0; j < events.length; j++) {
      const event = events[j];
      const rawTitle = event.getTitle();
      const isGoal = rawTitle.includes('【目標】');
      const cleanTitle = rawTitle.replace('【目標】', '').replace('【タスク】', '');
      const timeText = formatEventTime(event, d);
      const displayTitle = (isGoal ? '★ ' : '') + cleanTitle;

      bodyContents.push({
        "type": "box",
        "layout": "baseline",
        "spacing": "sm",
        "margin": "sm",
        "contents": [
          { "type": "text", "text": timeText, "size": "xs", "color": "#999999", "flex": 4 },
          { "type": "text", "text": displayTitle, "size": "sm", "color": isGoal ? '#E85D3B' : '#3D2510', "flex": 8, "wrap": true }
        ]
      });
    }
  }

  if (!hasAny) {
    replyLineMessage(replyToken, '今後1週間の予定はありません。');
    return;
  }

  const endDate = new Date(today.getTime() + 6 * 24 * 60 * 60 * 1000);
  const rangeText = Utilities.formatDate(today, 'Asia/Tokyo', 'M/d') + '(' + weekDayLabels[today.getDay()] + ')'
    + ' 〜 ' + Utilities.formatDate(endDate, 'Asia/Tokyo', 'M/d') + '(' + weekDayLabels[endDate.getDay()] + ')';

  sendLinePayload(replyToken, {
    "type": "flex",
    "altText": "今後1週間の予定",
    "contents": {
      "type": "bubble",
      "size": "mega",
      "header": {
        "type": "box",
        "layout": "vertical",
        "backgroundColor": "#F5EDD9",
        "paddingAll": "md",
        "contents": [
          { "type": "text", "text": "今後1週間の予定", "weight": "bold", "size": "lg", "color": "#3D2510" },
          { "type": "text", "text": rangeText, "size": "xs", "color": "#6B4A2A", "margin": "xs" }
        ]
      },
      "body": {
        "type": "box",
        "layout": "vertical",
        "spacing": "none",
        "paddingAll": "md",
        "contents": bodyContents
      }
    }
  });
}

function notifyMorning() {
  try {
    const calendar = getTargetCalendar();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const allEvents = calendar.getEvents(today, new Date(today.getTime() + 180 * 24 * 60 * 60 * 1000));

    let milestones = [], tasks = [], nextWeek = [];
    for (let i = 0; i < allEvents.length; i++) {
      const event = allEvents[i];
      const title = event.getTitle();
      const eventDate = new Date(event.getStartTime());
      eventDate.setHours(0, 0, 0, 0);
      const diffDays = Math.ceil((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

      if (title.includes('【目標】') && diffDays >= 0) {
        milestones.push({ title: title.replace('【目標】', ''), days: diffDays });
      } else if (title.includes('【タスク】') && diffDays >= 0 && diffDays <= 3) {
        tasks.push({ title: title.replace('【タスク】', ''), days: diffDays });
      } else if (diffDays === 7) {
        nextWeek.push({
          title: title,
          time: formatEventTime(event, eventDate)
        });
      }
    }

    const weather = getWeatherForecastLines();
    const weekDayLabels = ['日', '月', '火', '水', '木', '金', '土'];
    const dateLabel = Utilities.formatDate(today, 'Asia/Tokyo', 'M/d') + '(' + weekDayLabels[today.getDay()] + ')';

    const bodyContents = [];

    // 天気
    bodyContents.push(makeSectionHeader('■ 天気予報（' + WEATHER_AREA_LABEL + '）'));
    for (let i = 0; i < weather.length; i++) {
      bodyContents.push(makeRow(weather[i].label, weather[i].text, '#999999'));
    }

    // 目標カウントダウン
    if (milestones.length > 0) {
      bodyContents.push(makeSectionHeader('■ 目標カウントダウン'));
      for (let i = 0; i < milestones.length; i++) {
        bodyContents.push(makeRow('あと ' + milestones[i].days + '日', milestones[i].title, '#E85D3B'));
      }
    }

    // 期限が迫るタスク
    bodyContents.push(makeSectionHeader('■ 期限が迫っているタスク'));
    if (tasks.length > 0) {
      for (let i = 0; i < tasks.length; i++) {
        const left = tasks[i].days === 0 ? '今日まで' : '残り' + tasks[i].days + '日';
        bodyContents.push(makeRow(left, tasks[i].title, '#999999'));
      }
    } else {
      bodyContents.push({ "type": "text", "text": "現在はありません。", "size": "sm", "color": "#999999", "margin": "xs" });
    }

    // 1週間後の予定
    bodyContents.push(makeSectionHeader('■ 1週間後の予定'));
    if (nextWeek.length > 0) {
      for (let i = 0; i < nextWeek.length; i++) {
        bodyContents.push(makeRow(nextWeek[i].time, nextWeek[i].title, '#999999'));
      }
    } else {
      bodyContents.push({ "type": "text", "text": "特にありません。", "size": "sm", "color": "#999999", "margin": "xs" });
    }

    pushLinePayload({
      "type": "flex",
      "altText": "おはようございます。今日の状況をお知らせします",
      "contents": {
        "type": "bubble",
        "size": "mega",
        "header": {
          "type": "box", "layout": "vertical", "backgroundColor": "#FFE8BC", "paddingAll": "md",
          "contents": [
            { "type": "text", "text": "おはようございます", "weight": "bold", "size": "lg", "color": "#3D2510" },
            { "type": "text", "text": dateLabel, "size": "xs", "color": "#6B4A2A", "margin": "xs" }
          ]
        },
        "body": {
          "type": "box", "layout": "vertical", "paddingAll": "md", "contents": bodyContents
        }
      }
    });
  } catch (err) {
    console.error('notifyMorning error: ' + (err && err.message ? err.message : err));
  }
}

function notifyNight() {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const events = getTargetCalendar().getEventsForDay(tomorrow);
    let scheduleList = [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const title = event.getTitle();
      const isGoal = title.includes('【目標】');
      const cleanTitle = title.replace('【目標】', '').replace('【タスク】', '');
      scheduleList.push({
        time: formatEventTime(event, tomorrow),
        title: (isGoal ? '★ ' : '') + cleanTitle,
        isGoal: isGoal
      });
    }

    const weekDayLabels = ['日', '月', '火', '水', '木', '金', '土'];
    const dateLabel = Utilities.formatDate(tomorrow, 'Asia/Tokyo', 'M/d') + '(' + weekDayLabels[tomorrow.getDay()] + ')';

    const bodyContents = [];

    bodyContents.push(makeSectionHeader('■ 明日の予定'));
    if (scheduleList.length > 0) {
      for (let i = 0; i < scheduleList.length; i++) {
        const s = scheduleList[i];
        bodyContents.push({
          "type": "box", "layout": "baseline", "spacing": "sm", "margin": "sm",
          "contents": [
            { "type": "text", "text": s.time, "size": "xs", "color": "#999999", "flex": 4 },
            { "type": "text", "text": s.title, "size": "sm", "color": s.isGoal ? '#E85D3B' : '#3D2510', "flex": 8, "wrap": true }
          ]
        });
      }
    } else {
      bodyContents.push({ "type": "text", "text": "特にありません。", "size": "sm", "color": "#999999", "margin": "xs" });
    }

    pushLinePayload({
      "type": "flex",
      "altText": "明日の予定",
      "contents": {
        "type": "bubble",
        "size": "mega",
        "header": {
          "type": "box", "layout": "vertical", "backgroundColor": "#4A6590", "paddingAll": "md",
          "contents": [
            { "type": "text", "text": "明日の予定", "weight": "bold", "size": "lg", "color": "#F5EDD9" },
            { "type": "text", "text": dateLabel, "size": "xs", "color": "#C9D4E5", "margin": "xs" }
          ]
        },
        "body": {
          "type": "box", "layout": "vertical", "paddingAll": "md", "contents": bodyContents
        }
      }
    });
  } catch (err) {
    console.error('notifyNight error: ' + (err && err.message ? err.message : err));
  }
}

// 気象庁APIから天気を取得し、日別に配列で返す（Flexで行ごとに表示するため）
function getWeatherForecastLines() {
  try {
    const data = JSON.parse(UrlFetchApp.fetch('https://www.jma.go.jp/bosai/forecast/data/forecast/' + WEATHER_AREA_CODE + '.json').getContentText());
    const weathers = data[0].timeSeries[0].areas[0].weathers;
    const labels = ['今日', '明日', '明後日'];
    const result = [];
    for (let i = 0; i < 3; i++) {
      result.push({ label: labels[i], text: weathers[i].replace(/　/g, ' ') });
    }
    return result;
  } catch(e) {
    return [{ label: '取得失敗', text: '天気情報を取得できませんでした' }];
  }
}

// Flex Message用の共通パーツ
function makeSectionHeader(text) {
  return {
    "type": "box", "layout": "vertical", "margin": "lg",
    "contents": [
      { "type": "text", "text": text, "weight": "bold", "size": "sm", "color": "#3D2510" },
      { "type": "separator", "margin": "xs", "color": "#D9CDB0" }
    ]
  };
}

function makeRow(leftText, rightText, leftColor) {
  return {
    "type": "box", "layout": "baseline", "spacing": "sm", "margin": "sm",
    "contents": [
      { "type": "text", "text": leftText, "size": "xs", "color": leftColor || '#999999', "flex": 4 },
      { "type": "text", "text": rightText, "size": "sm", "color": "#3D2510", "flex": 8, "wrap": true }
    ]
  };
}

// 予定の時間ラベルを返す
//   通常: 「HH:mm〜HH:mm」
//   当日以前からの継続で当日中に終了: 「継続〜HH:mm」
//   当日以前から継続し翌日以降まで続く: 「継続中」
//   当日開始だが翌日以降まで続く: 「HH:mm〜翌日」
//   終日: 「終日」
function formatEventTime(event, dayStart) {
  if (event.isAllDayEvent()) return '終日';
  const start = event.getStartTime();
  const end = event.getEndTime();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const startsBeforeDay = start.getTime() < dayStart.getTime();
  const endsAfterDay = end.getTime() > dayEnd.getTime();
  const fmt = function(d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'HH:mm'); };

  if (startsBeforeDay && endsAfterDay) return '継続中';
  if (startsBeforeDay) return '継続〜' + fmt(end);
  if (endsAfterDay) return fmt(start) + '〜翌日';
  return fmt(start) + '〜' + fmt(end);
}

// --- 通信ユーティリティ ---

function sendLinePayload(replyToken, payload) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    'method': 'post',
    'headers': { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_ACCESS_TOKEN },
    'payload': JSON.stringify({ 'replyToken': replyToken, 'messages': [payload] })
  });
}

// 任意のメッセージオブジェクト（Flex・テキスト等）をpush通知として送る
function pushLinePayload(payload) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    'method': 'post',
    'headers': { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_ACCESS_TOKEN },
    'payload': JSON.stringify({ 'to': LINE_USER_ID, 'messages': [payload] })
  });
}

function replyLineMessage(replyToken, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    'method': 'post',
    'headers': { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_ACCESS_TOKEN },
    'payload': JSON.stringify({ 'replyToken': replyToken, 'messages': [{ 'type': 'text', 'text': text }] })
  });
}

function sendQuickReply(replyToken, text, items) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    'method': 'post',
    'headers': { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_ACCESS_TOKEN },
    'payload': JSON.stringify({ 'replyToken': replyToken, 'messages': [{ 'type': 'text', 'text': text, 'quickReply': { 'items': items } }] })
  });
}

// --- トリガー自動設定用プログラム ---
// 自分が管理する関数（notifyMorning / notifyNight）のトリガーのみを削除して
// 再作成する。ユーザーが追加した他のトリガーは巻き添えにしない。
// inTimezone('Asia/Tokyo') で時刻解釈を JST に固定、nearMinute(0) で発火を
// 各時刻の前後 ±15分 に寄せる（GAS 仕様上、より厳密な時刻指定は不可能）
function setTriggers() {
  const MANAGED = ['notifyMorning', 'notifyNight'];
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (MANAGED.indexOf(triggers[i].getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('notifyMorning')
    .timeBased()
    .inTimezone('Asia/Tokyo')
    .everyDays(1)
    .atHour(7)
    .nearMinute(0)
    .create();

  ScriptApp.newTrigger('notifyNight')
    .timeBased()
    .inTimezone('Asia/Tokyo')
    .everyDays(1)
    .atHour(20)
    .nearMinute(0)
    .create();

  Logger.log('トリガーを設定しました。notifyMorning: 7:00 前後, notifyNight: 20:00 前後（いずれもJST）');
}
