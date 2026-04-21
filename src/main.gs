// ==========================================
// 設定情報
// ==========================================
const LINE_ACCESS_TOKEN = 'ここにアクセストークンを貼り付けます';
const LINE_USER_ID = 'ここにユーザーIDを貼り付けます';

// ==========================================
// LINE Webhook処理
// ==========================================
function doPost(e) {
  const event = JSON.parse(e.postData.contents).events[0];
  const replyToken = event.replyToken;

  // --- A. メッセージ受信時の処理 ---
  if (event.type === 'message') {
    const userMessage = event.message.text;

    if (userMessage === '目標設定') {
      showGoalSelection(replyToken);
    }
    else if (userMessage.startsWith('これを目標にする：')) {
      handleGoalConfirmation(replyToken, userMessage);
    }
    else {
      // 1. タスク名を受け取り、開始時間選択GUIを出す
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

    if (params.action === 'setStart') {
      // 2. 開始時間を受け取り、終了時間選択GUIを出す
      const taskName = params.name;
      const startTime = event.postback.params.datetime;
      sendEndDateTimePicker(replyToken, taskName, startTime);
    }
    else if (params.action === 'setEnd') {
      // 3. 終了時間を受け取り、目標にするか確認する
      const taskName = params.name;
      const startTime = params.start;
      const endTime = event.postback.params.datetime;
      sendFinalGoalConfirm(replyToken, taskName, startTime, endTime);
    }
    else if (params.action === 'finalRegister') {
      // 4. 最終登録実行
      executeFinalRegistration(replyToken, params);
    }
  }
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
        'data': 'action=setStart&name=' + taskName,
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
      'text': '次に【終了時間】を選んでください。',
      'actions': [{
        'type': 'datetimepicker',
        'label': 'カレンダーを開く',
        'data': 'action=setEnd&name=' + taskName + '&start=' + startTime,
        'mode': 'datetime'
      }]
    }
  });
}

// ステップ3：目標にするか確認する
function sendFinalGoalConfirm(replyToken, taskName, startTime, endTime) {
  sendLinePayload(replyToken, {
    'type': 'template',
    'altText': '目標に設定しますか？',
    'template': {
      'type': 'confirm',
      'text': 'このタスクを「重要目標（カウントダウン対象）」として登録しますか？',
      'actions': [
        { 'type': 'postback', 'label': 'はい', 'data': 'action=finalRegister&isGoal=true&name=' + taskName + '&start=' + startTime + '&end=' + endTime },
        { 'type': 'postback', 'label': 'いいえ', 'data': 'action=finalRegister&isGoal=false&name=' + taskName + '&start=' + startTime + '&end=' + endTime }
      ]
    }
  });
}

// ステップ4：カレンダーへ書き込み
function executeFinalRegistration(replyToken, params) {
  const taskName = params.name;
  const startDt = new Date(params.start);
  const endDt = new Date(params.end);
  const isGoal = params.isGoal === 'true';

  const prefix = isGoal ? '【目標】' : '【タスク】';
  CalendarApp.getDefaultCalendar().createEvent(prefix + taskName, startDt, endDt);

  const dateStr = Utilities.formatDate(startDt, 'Asia/Tokyo', 'M/d HH:mm');
  const msg = "✅ カレンダーに登録しました！\n日時：" + dateStr + "\n内容：" + prefix + taskName + (isGoal ? "\n※目標として設定されました。" : "");
  replyLineMessage(replyToken, msg);
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
    if (!title.includes('ごみ') && !title.includes('【目標】')) {
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

function notifyMorning() {
  const calendar = CalendarApp.getDefaultCalendar();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weatherMessage = getWeatherForecast();
  const allEvents = calendar.getEvents(today, new Date(today.getTime() + 180 * 24 * 60 * 60 * 1000));

  let milestoneMessages = [], taskMessages = [], nextWeekEvents = [];
  for (let i = 0; i < allEvents.length; i++) {
    const event = allEvents[i];
    const title = event.getTitle();
    const eventDate = new Date(event.getStartTime());
    eventDate.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (title.includes('【目標】') && diffDays >= 0) milestoneMessages.push('🚩 ' + title.replace('【目標】', '') + ' まであと ' + diffDays + ' 日');
    else if (title.includes('【タスク】') && diffDays >= 0 && diffDays <= 3) taskMessages.push(diffDays === 0 ? '・今日まで: ' + title.replace('【タスク】','') : '・残り' + diffDays + '日: ' + title.replace('【タスク】',''));
    else if (diffDays === 7 && !title.includes('ごみ')) nextWeekEvents.push('・' + (event.isAllDayEvent() ? '終日' : Utilities.formatDate(event.getStartTime(), 'Asia/Tokyo', 'HH:mm')) + ': ' + title);
  }

  let message = '☀️ おはようございます！\n現在の状況をお知らせします。\n\n' + weatherMessage;
  if (milestoneMessages.length > 0) message += milestoneMessages.join('\n') + '\n\n';
  message += '【期限が迫っているタスク】\n' + (taskMessages.length > 0 ? taskMessages.join('\n') : '現在はありません。') + '\n\n';
  message += '【1週間後の予定】\n' + (nextWeekEvents.length > 0 ? nextWeekEvents.join('\n') : '特にありません。');
  sendLineMessage(message);
}

function notifyNight() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const events = CalendarApp.getDefaultCalendar().getEventsForDay(tomorrow);
  let garbageList = [], scheduleList = [];
  for (let i = 0; i < events.length; i++) {
    const title = events[i].getTitle();
    if (title.includes('ごみ')) garbageList.push(title);
    else scheduleList.push('・' + (events[i].isAllDayEvent() ? '終日' : Utilities.formatDate(events[i].getStartTime(), 'Asia/Tokyo', 'HH:mm')) + ': ' + title);
  }
  let message = '🌙 明日の予定をお知らせします\n\n' + (scheduleList.length > 0 ? scheduleList.join('\n') : '予定は特にありません。') + '\n\n';
  if (garbageList.length > 0) message += '🗑️ 明日は「' + garbageList.join('と') + '」の日です！';
  sendLineMessage(message);
}

function getWeatherForecast() {
  try {
    const data = JSON.parse(UrlFetchApp.fetch('https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json').getContentText());
    const weathers = data[0].timeSeries[0].areas[0].weathers;
    let msg = '☁️ 【東京の天気予報】\n';
    const labels = ['今日', '明日', '明後日'];
    for (let i = 0; i < 3; i++) msg += '・' + labels[i] + ': ' + weathers[i].replace(/　/g, ' ') + '\n';
    return msg + '\n';
  } catch(e) { return '☁️ 【天気予報】取得失敗\n\n'; }
}

// --- 通信ユーティリティ ---

function sendLinePayload(replyToken, payload) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    'method': 'post',
    'headers': { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_ACCESS_TOKEN },
    'payload': JSON.stringify({ 'replyToken': replyToken, 'messages': [payload] })
  });
}

function sendLineMessage(text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    'method': 'post',
    'headers': { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_ACCESS_TOKEN },
    'payload': JSON.stringify({ 'to': LINE_USER_ID, 'messages': [{ 'type': 'text', 'text': text }] })
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
