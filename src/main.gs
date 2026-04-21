// ==========================================
// 設定情報
// ==========================================
const LINE_ACCESS_TOKEN = 'ここにアクセストークンを貼り付けます';
const LINE_USER_ID = 'ここにユーザーIDを貼り付けます';

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
    const event = events[0];

    // 送信元ユーザーIDチェック
    const sourceUserId = event.source && event.source.userId;
    if (sourceUserId !== LINE_USER_ID) {
      console.log('Rejected unauthorized userId: ' + sourceUserId);
      return;
    }

    const replyToken = event.replyToken;

    // --- A. メッセージ受信時の処理 ---
    if (event.type === 'message') {
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
        // タスク登録フロー開始。既存セッションがあっても新メッセージで上書きし、
        // 古い開始/終了ピッカーのボタンは以降のポストバックで無視される
        setTaskSession({ step: 'awaitingStart', taskName: userMessage });
        sendStartDateTimePicker(replyToken, userMessage);
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

      const session = getTaskSession();
      if (!session) {
        console.log('Ignoring postback: no active session. action=' + params.action);
        return;
      }

      if (params.action === 'setStart' && session.step === 'awaitingStart') {
        const startTime = event.postback.params.datetime;
        setTaskSession({ step: 'awaitingEnd', taskName: session.taskName, startTime: startTime });
        sendEndDateTimePicker(replyToken, session.taskName, startTime);
      }
      else if (params.action === 'setEnd' && session.step === 'awaitingEnd') {
        const endTime = event.postback.params.datetime;
        setTaskSession({
          step: 'awaitingConfirm',
          taskName: session.taskName,
          startTime: session.startTime,
          endTime: endTime
        });
        sendFinalGoalConfirm(replyToken);
      }
      else if (params.action === 'finalRegister' && session.step === 'awaitingConfirm') {
        const isGoal = params.isGoal === 'true';
        // 登録前にセッションをクリア。万一二重発火しても後続は session=null で弾かれる
        clearTaskSession();
        executeFinalRegistration(replyToken, session.taskName, session.startTime, session.endTime, isGoal);
      }
      else {
        console.log('Ignoring stale/out-of-order postback. action=' + params.action + ', step=' + session.step);
      }
    }
  } catch (err) {
    console.error('doPost error: ' + (err && err.message ? err.message : err));
  }
}

// タスク登録フローのセッション管理（PropertiesServiceで永続化）
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

// ==========================================
// ロジック関数：タスクGUI登録（対話ステップ）
// ==========================================

// ステップ1：開始時間をきく
function sendStartDateTimePicker(replyToken, taskName) {
  sendLinePayload(replyToken, {
    'type': 'template',
    'altText': '開始時間を選択してください',
    'template': {
      'type': 'buttons',
      'text': '「' + taskName + '」の【開始時間】を選んでください。',
      'actions': [{
        'type': 'datetimepicker',
        'label': 'カレンダーを開く',
        'data': 'action=setStart',
        'mode': 'datetime'
      }]
    }
  });
}

// ステップ2：終了時間をきく
function sendEndDateTimePicker(replyToken, taskName, startTime) {
  sendLinePayload(replyToken, {
    'type': 'template',
    'altText': '終了時間を選択してください',
    'template': {
      'type': 'buttons',
      'text': '「' + taskName + '」の【終了時間】を選んでください。',
      'actions': [{
        'type': 'datetimepicker',
        'label': 'カレンダーを開く',
        'data': 'action=setEnd',
        'mode': 'datetime',
        // 開始時刻より前を選べないようにガード
        'min': startTime,
        'initial': startTime
      }]
    }
  });
}

// ステップ3：目標にするか確認する
function sendFinalGoalConfirm(replyToken) {
  sendLinePayload(replyToken, {
    'type': 'template',
    'altText': '目標に設定しますか？',
    'template': {
      'type': 'confirm',
      'text': 'このタスクを「重要目標（カウントダウン対象）」として登録しますか？',
      'actions': [
        { 'type': 'postback', 'label': 'はい', 'data': 'action=finalRegister&isGoal=true' },
        { 'type': 'postback', 'label': 'いいえ', 'data': 'action=finalRegister&isGoal=false' }
      ]
    }
  });
}

// ステップ4：カレンダーへ書き込み
// 複数日（開始日と終了日が2日以上離れている）の場合は時間指定ではなく終日イベントとして登録する。
// GASの createAllDayEvent(startDate, endDateExclusive) を使うと GCal の上部バーにきれいに収まる
function executeFinalRegistration(replyToken, taskName, startTimeStr, endTimeStr, isGoal) {
  const startDt = new Date(startTimeStr);
  const endDt = new Date(endTimeStr);
  const prefix = isGoal ? '【目標】' : '【タスク】';
  const title = prefix + taskName;
  const calendar = CalendarApp.getDefaultCalendar();

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
  const calendar = CalendarApp.getDefaultCalendar();
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
  const events = CalendarApp.getDefaultCalendar().getEvents(new Date(), new Date(new Date().setMonth(new Date().getMonth() + 6)));
  for (let i = 0; i < events.length; i++) {
    if (events[i].getTitle() === targetTitle) {
      events[i].setTitle('【目標】' + targetTitle);
      replyLineMessage(replyToken, "「" + targetTitle + "」を目標に設定しました。");
      return;
    }
  }
}

// リッチメニュー「予定確認」から呼ばれる：今日から7日分の予定をFlex Messageで返す
// 各日 getEventsForDay で取得するため、複数日にまたがる予定は該当する各日に出現する（取りこぼしなし）
function replyUpcomingWeekSchedule(replyToken) {
  const calendar = CalendarApp.getDefaultCalendar();
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
    const calendar = CalendarApp.getDefaultCalendar();
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
    bodyContents.push(makeSectionHeader('■ 天気予報（東京）'));
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
    const events = CalendarApp.getDefaultCalendar().getEventsForDay(tomorrow);
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
    const data = JSON.parse(UrlFetchApp.fetch('https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json').getContentText());
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
function setTriggers() {
  // 1. 既存のトリガーをすべて削除（重複して通知がいくのを防ぐ安全装置）
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }

  // 2. 朝用トリガーの設定（毎日 午前7時〜8時の間に実行）
  ScriptApp.newTrigger('notifyMorning')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();

  // 3. 夜用トリガーの設定（毎日 午後8時〜9時の間に実行）
  ScriptApp.newTrigger('notifyNight')
    .timeBased()
    .everyDays(1)
    .atHour(20)
    .create();

  Logger.log('トリガーの設定が完了しました。');
}
