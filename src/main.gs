// ==========================================
// 設定情報
// ==========================================
const LINE_ACCESS_TOKEN = 'ここにアクセストークンを貼り付けます';
const LINE_USER_ID = 'ここにユーザーIDを貼り付けます';

// ==========================================
// LINE Webhook処理
// ==========================================
function doPost(e) {
  try {
    const events = JSON.parse(e.postData.contents).events;
    if (!events || events.length === 0) return;
    const event = events[0];

    // 送信元ユーザーIDチェック
    // GAS の Webhook URL が万が一漏れた場合でも、攻撃者の userId は LINE_USER_ID と一致しないため拒否される。
    // このチェックは本ボットが「本人1人専用」前提のため有効。複数ユーザー運用する場合は設計から見直すこと
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
        showGoalSelection(replyToken);
      }
      else if (userMessage === '予定確認') {
        replyUpcomingWeekSchedule(replyToken);
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
  } catch (err) {
    console.error('doPost error: ' + (err && err.message ? err.message : err));
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
    const rawEvents = calendar.getEventsForDay(d);
    const events = [];
    for (let k = 0; k < rawEvents.length; k++) {
      if (!rawEvents[k].getTitle().includes('ごみ')) events.push(rawEvents[k]);
    }
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

      // 時間ラベル：終日 / 前日以前からの継続 / 通常時刻
      let timeText;
      if (event.isAllDayEvent()) {
        timeText = '終日';
      } else if (event.getStartTime().getTime() < d.getTime()) {
        timeText = '継続中';
      } else {
        timeText = Utilities.formatDate(event.getStartTime(), 'Asia/Tokyo', 'HH:mm');
      }

      bodyContents.push({
        "type": "box",
        "layout": "baseline",
        "spacing": "sm",
        "margin": "sm",
        "contents": [
          { "type": "text", "text": timeText, "size": "xs", "color": "#999999", "flex": 3 },
          { "type": "text", "text": (isGoal ? "🚩 " : "") + cleanTitle, "size": "sm", "color": "#3D2510", "flex": 9, "wrap": true }
        ]
      });
    }
  }

  if (!hasAny) {
    replyLineMessage(replyToken, '📆 今後1週間の予定はありません。');
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
          { "type": "text", "text": "📆 今後1週間の予定", "weight": "bold", "size": "lg", "color": "#3D2510" },
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
      } else if (diffDays === 7 && !title.includes('ごみ')) {
        nextWeek.push({
          title: title,
          time: event.isAllDayEvent() ? '終日' : Utilities.formatDate(event.getStartTime(), 'Asia/Tokyo', 'HH:mm')
        });
      }
    }

    const weather = getWeatherForecastLines();
    const weekDayLabels = ['日', '月', '火', '水', '木', '金', '土'];
    const dateLabel = Utilities.formatDate(today, 'Asia/Tokyo', 'M/d') + '(' + weekDayLabels[today.getDay()] + ')';

    const bodyContents = [];

    // 天気
    bodyContents.push(makeSectionHeader('☁️ 天気予報（東京）'));
    for (let i = 0; i < weather.length; i++) {
      bodyContents.push(makeRow(weather[i].label, weather[i].text, '#999999'));
    }

    // 目標カウントダウン
    if (milestones.length > 0) {
      bodyContents.push(makeSectionHeader('🚩 目標カウントダウン'));
      for (let i = 0; i < milestones.length; i++) {
        bodyContents.push(makeRow('あと ' + milestones[i].days + '日', milestones[i].title, '#E85D3B'));
      }
    }

    // 期限が迫るタスク
    bodyContents.push(makeSectionHeader('⏰ 期限が迫っているタスク'));
    if (tasks.length > 0) {
      for (let i = 0; i < tasks.length; i++) {
        const left = tasks[i].days === 0 ? '今日まで' : '残り' + tasks[i].days + '日';
        bodyContents.push(makeRow(left, tasks[i].title, '#999999'));
      }
    } else {
      bodyContents.push({ "type": "text", "text": "現在はありません。", "size": "sm", "color": "#999999", "margin": "xs" });
    }

    // 1週間後の予定
    bodyContents.push(makeSectionHeader('📆 1週間後の予定'));
    if (nextWeek.length > 0) {
      for (let i = 0; i < nextWeek.length; i++) {
        bodyContents.push(makeRow(nextWeek[i].time, nextWeek[i].title, '#999999'));
      }
    } else {
      bodyContents.push({ "type": "text", "text": "特にありません。", "size": "sm", "color": "#999999", "margin": "xs" });
    }

    pushLinePayload({
      "type": "flex",
      "altText": "☀️ おはようございます！今日の状況をお知らせします",
      "contents": {
        "type": "bubble",
        "size": "mega",
        "header": {
          "type": "box", "layout": "vertical", "backgroundColor": "#FFE8BC", "paddingAll": "md",
          "contents": [
            { "type": "text", "text": "☀️ おはようございます", "weight": "bold", "size": "lg", "color": "#3D2510" },
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
    const events = CalendarApp.getDefaultCalendar().getEventsForDay(tomorrow);
    let garbageList = [], scheduleList = [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const title = event.getTitle();
      if (title.includes('ごみ')) {
        garbageList.push(title);
      } else {
        const rawTitle = title;
        const isGoal = rawTitle.includes('【目標】');
        const cleanTitle = rawTitle.replace('【目標】', '').replace('【タスク】', '');
        let timeText;
        if (event.isAllDayEvent()) {
          timeText = '終日';
        } else if (event.getStartTime().getTime() < tomorrow.getTime()) {
          timeText = '継続中';
        } else {
          timeText = Utilities.formatDate(event.getStartTime(), 'Asia/Tokyo', 'HH:mm');
        }
        scheduleList.push({ time: timeText, title: (isGoal ? '🚩 ' : '') + cleanTitle });
      }
    }

    const weekDayLabels = ['日', '月', '火', '水', '木', '金', '土'];
    const dateLabel = Utilities.formatDate(tomorrow, 'Asia/Tokyo', 'M/d') + '(' + weekDayLabels[tomorrow.getDay()] + ')';

    const bodyContents = [];

    bodyContents.push(makeSectionHeader('📆 明日の予定'));
    if (scheduleList.length > 0) {
      for (let i = 0; i < scheduleList.length; i++) {
        bodyContents.push(makeRow(scheduleList[i].time, scheduleList[i].title, '#999999'));
      }
    } else {
      bodyContents.push({ "type": "text", "text": "特にありません。", "size": "sm", "color": "#999999", "margin": "xs" });
    }

    if (garbageList.length > 0) {
      bodyContents.push(makeSectionHeader('🗑️ 明日のゴミ出し'));
      bodyContents.push({
        "type": "text",
        "text": '「' + garbageList.join('と') + '」の日です',
        "size": "sm", "color": "#3D2510", "margin": "xs", "wrap": true
      });
    }

    pushLinePayload({
      "type": "flex",
      "altText": "🌙 明日の予定",
      "contents": {
        "type": "bubble",
        "size": "mega",
        "header": {
          "type": "box", "layout": "vertical", "backgroundColor": "#4A6590", "paddingAll": "md",
          "contents": [
            { "type": "text", "text": "🌙 明日の予定", "weight": "bold", "size": "lg", "color": "#F5EDD9" },
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
      { "type": "text", "text": leftText, "size": "xs", "color": leftColor || '#999999', "flex": 3 },
      { "type": "text", "text": rightText, "size": "sm", "color": "#3D2510", "flex": 7, "wrap": true }
    ]
  };
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
