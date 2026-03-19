// ============================================================
// 引越し見積もりLINEボット - メインサーバー v2
// ============================================================

const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const client = new line.Client(config);

const sessions = {};
function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { step: 'welcome', data: { photos: [] } };
  }
  return sessions[userId];
}

app.post('/webhook', line.middleware(config), async (req, res) => {
  res.sendStatus(200);
  await Promise.all(req.body.events.map(handleEvent));
});

async function handleEvent(event) {
  const userId = event.source.userId;
  const session = getSession(userId);
  if (event.type === 'message' && event.message.type === 'text') {
    await handleText(userId, event.message.text.trim(), session, event.replyToken);
  }
  if (event.type === 'message' && event.message.type === 'image') {
    await handleImage(userId, event.message.id, session, event.replyToken);
  }
}

async function handleText(userId, text, session, replyToken) {
  const { step, data } = session;

  if (text === 'リセット' || text === 'やり直す') {
    sessions[userId] = { step: 'welcome', data: { photos: [] } };
    await replyWelcome(replyToken);
    return;
  }

  switch (step) {
    case 'welcome':
      await replyWelcome(replyToken);
      session.step = 'ask_from_address';
      break;

    case 'ask_from_address':
      data.from = text;
      session.step = 'ask_from_type';
      await client.replyMessage(replyToken, [
        quickReply(
          `📍 現在のお住まい：${text}\n\n建物の種類を教えてください。`,
          ['一戸建て', 'マンション・アパート']
        ),
      ]);
      break;

    case 'ask_from_type':
      data.fromType = text;
      session.step = 'ask_from_road';
      await client.replyMessage(replyToken, [
        quickReply(
          `🏠 ${text} ですね。\n\n現在のお住まいの前の道は\n4メートル以上ありますか？\n（トラックの駐車スペースに関係します）`,
          ['4m以上ある', '4mより狭い', 'わからない']
        ),
      ]);
      break;

    case 'ask_from_road':
      data.fromRoad = text;
      session.step = 'ask_to_address';
      await client.replyMessage(replyToken, [
        textMsg(`✅ 現在のお住まいの情報を受け取りました！\n\n次に、引越し先の住所を教えてください。\n（例：神奈川県横浜市）`),
      ]);
      break;

    case 'ask_to_address':
      data.to = text;
      data.distanceInfo = calcDistanceInfo(data.from, data.to);
      session.step = 'ask_to_type';
      await client.replyMessage(replyToken, [
        quickReply(
          `📍 引越し先：${text}\n\n建物の種類を教えてください。`,
          ['一戸建て', 'マンション・アパート']
        ),
      ]);
      break;

    case 'ask_to_type':
      data.toType = text;
      session.step = 'ask_to_road';
      await client.replyMessage(replyToken, [
        quickReply(
          `🏠 ${text} ですね。\n\n引越し先の前の道は\n4メートル以上ありますか？`,
          ['4m以上ある', '4mより狭い', 'わからない']
        ),
      ]);
      break;

    case 'ask_to_road':
      data.toRoad = text;
      session.step = 'ask_family';
      const distMsg = buildDistanceMessage(data.distanceInfo);
      await client.replyMessage(replyToken, [
        textMsg(distMsg),
        quickReply(
          `次に、ご家族の人数・構成を教えてください。`,
          ['一人暮らし', '夫婦2人', '3人家族', '4人以上']
        ),
      ]);
      break;

    case 'ask_family':
      data.family = text;
      session.step = 'ask_photo_living';
      data.photos = [];
      await client.replyMessage(replyToken, [
        textMsg(
          `✅ 基本情報を受け取りました！\n\n` +
          `━━━━━━━━━━━━\n` +
          `🏠 現在のお住まい：${data.from}（${data.fromType}）\n` +
          `📍 引越し先：${data.to}（${data.toType}）\n` +
          `👨‍👩‍👧 家族構成：${data.family}\n` +
          `🚛 推定距離：${data.distanceInfo.label}\n` +
          `━━━━━━━━━━━━\n\n` +
          `次に各部屋の写真を送ってください 📸\n\n` +
          `【1枚目】リビングの写真を送ってください`
        ),
      ]);
      break;

    case 'ask_photo_living':
    case 'ask_photo_bedroom':
    case 'ask_photo_kitchen':
      await client.replyMessage(replyToken, [
        textMsg('📸 写真（画像ファイル）を送ってください！'),
      ]);
      break;

    case 'select_plan':
      data.selectedPlan = text;
      session.step = 'done';
      await sendFinalEstimate(replyToken, data);
      break;

    default:
      await replyWelcome(replyToken);
      session.step = 'ask_from_address';
  }
}

async function handleImage(userId, messageId, session, replyToken) {
  const { step, data } = session;
  const photoSteps = ['ask_photo_living', 'ask_photo_bedroom', 'ask_photo_kitchen'];

  if (!photoSteps.includes(step)) {
    await client.replyMessage(replyToken, [
      textMsg('今は写真は受け付けていません。\n「リセット」で最初からやり直せます。'),
    ]);
    return;
  }

  await client.replyMessage(replyToken, [textMsg('📸 受け取りました！')]);

  const imageBuffer = await getLineImage(messageId);
  data.photos.push(imageBuffer.toString('base64'));

  if (step === 'ask_photo_living') {
    session.step = 'ask_photo_bedroom';
    await client.pushMessage(userId, [textMsg('【2枚目】寝室の写真を送ってください')]);

  } else if (step === 'ask_photo_bedroom') {
    session.step = 'ask_photo_kitchen';
    await client.pushMessage(userId, [textMsg('【3枚目】キッチンの写真を送ってください')]);

  } else if (step === 'ask_photo_kitchen') {
    session.step = 'analyzing';
    await client.pushMessage(userId, [
      textMsg('🔍 3部屋の写真を受け取りました！\nAIが荷物量を分析中です...\n少々お待ちください（20〜30秒）'),
    ]);

    try {
      const analysis = await analyzeWithClaude(data.photos, data);
      data.analysis = analysis;
      const plans = calcPlans(analysis.volume_m3, data);
      data.plans = plans;
      session.step = 'select_plan';

      await client.pushMessage(userId, [
        textMsg(
          `🎯 分析完了！\n` +
          `━━━━━━━━━━━━\n` +
          `📦 検出した荷物：${analysis.item_count}点\n` +
          `📐 推定荷物量：${analysis.volume_m3}㎥\n` +
          `🏠 部屋規模：${analysis.room_size}\n` +
          `━━━━━━━━━━━━\n` +
          `${analysis.summary}`
        ),
        textMsg(
          `🚛 アップル引越センターのプラン\n` +
          `━━━━━━━━━━━━\n` +
          plans.map((p, i) =>
            `${i + 1}. ${p.name}\n` +
            `   ${p.truck_type} ／ ${p.feature}\n` +
            `   目安料金：${p.price_range}\n`
          ).join('\n') +
          `━━━━━━━━━━━━\n` +
          `ご希望のプランを選んでください。`
        ),
        quickReply('プランを選んでください', plans.map(p => p.name)),
      ]);

    } catch (err) {
      console.error('Analysis error:', err);
      session.step = 'ask_photo_living';
      data.photos = [];
      await client.pushMessage(userId, [
        textMsg('⚠️ 分析中にエラーが発生しました。\nもう一度リビングの写真から送ってください。'),
      ]);
    }
  }
}

async function analyzeWithClaude(photos, userData) {
  const content = [];
  const labels = ['リビング', '寝室', 'キッチン'];
  photos.forEach((photo, i) => {
    content.push({ type: 'text', text: `【${labels[i] || i + 1}枚目】` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo } });
  });
  content.push({
    type: 'text',
    text: `あなたは引越し専門の荷物量査定AIです。
上記の部屋の写真（リビング・寝室・キッチン）を見て、以下をJSON形式で返してください。

家族構成: ${userData.family}
現在の住まい: ${userData.fromType}
引越し先: ${userData.toType}

{
  "item_count": 全部屋合計の家具・荷物の点数(数字),
  "volume_m3": 推定総荷物量(㎥、数字),
  "room_size": "1K" or "1LDK" or "2LDK" or "3LDK" など,
  "truck_size": "軽トラ" or "2t" or "3t" or "4t" or "大型",
  "summary": "荷物の概要を2〜3文で（日本語）",
  "notes": "特記事項があれば（大型家具・ピアノ等）"
}

JSONのみ返してください。`,
  });

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content }],
  });

  const raw = response.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch[0]);
}

function calcPlans(volumeM3, data) {
  const { distanceInfo, fromRoad, toRoad } = data;
  let basePrice, truckType;
  if (volumeM3 <= 5)       { basePrice = 35000;  truckType = '軽トラック'; }
  else if (volumeM3 <= 10) { basePrice = 55000;  truckType = '2tトラック'; }
  else if (volumeM3 <= 18) { basePrice = 85000;  truckType = '3tトラック'; }
  else                     { basePrice = 110000; truckType = '4tトラック'; }

  const roadExtra = (fromRoad === '4mより狭い' || toRoad === '4mより狭い') ? 10000 : 0;
  const distFactor = distanceInfo.factor;

  const plans = [
    { name: '梱包材無料プラン',   feature: '梱包材・ダンボール無料',  multiplier: 1.0  },
    { name: '家具組立付きプラン', feature: '家具の分解・組立込み',    multiplier: 1.12 },
    { name: '安心フルサポート',   feature: '梱包〜組立・保険充実',    multiplier: 1.25 },
  ];

  return plans.map(p => {
    const price = Math.round((basePrice * distFactor * p.multiplier + roadExtra) / 1000) * 1000;
    return { name: p.name, feature: p.feature, truck_type: truckType, price_range: `¥${price.toLocaleString()}〜`, base_price: price };
  });
}

function calcDistanceInfo(from, to) {
  const prefectures = {
    '北海道':0,'青森':1,'岩手':2,'宮城':3,'秋田':4,'山形':5,'福島':6,
    '茨城':7,'栃木':8,'群馬':9,'埼玉':10,'千葉':11,'東京':12,'神奈川':13,
    '新潟':14,'富山':15,'石川':16,'福井':17,'山梨':18,'長野':19,
    '岐阜':20,'静岡':21,'愛知':22,'三重':23,'滋賀':24,'京都':25,
    '大阪':26,'兵庫':27,'奈良':28,'和歌山':29,'鳥取':30,'島根':31,
    '岡山':32,'広島':33,'山口':34,'徳島':35,'香川':36,'愛媛':37,
    '高知':38,'福岡':39,'佐賀':40,'長崎':41,'熊本':42,'大分':43,
    '宮崎':44,'鹿児島':45,'沖縄':46,
  };
  let fromPref = null, toPref = null;
  for (const pref of Object.keys(prefectures)) {
    if (from.includes(pref)) fromPref = prefectures[pref];
    if (to.includes(pref))   toPref   = prefectures[pref];
  }
  if (fromPref === null || toPref === null) {
    return { km: 50, factor: 1.2, label: '同一エリア近辺', isLongDistance: false };
  }
  const diff = Math.abs(fromPref - toPref);
  if (diff === 0)  return { km: 20,  factor: 1.0, label: '同県内（約20km圏内）',  isLongDistance: false };
  if (diff <= 2)   return { km: 80,  factor: 1.2, label: '近隣県（約80km圏内）',  isLongDistance: false };
  if (diff <= 5)   return { km: 150, factor: 1.4, label: '中距離（約150km圏内）', isLongDistance: false };
  if (diff <= 10)  return { km: 250, factor: 1.8, label: '長距離（約250km）',      isLongDistance: true  };
  return               { km: 500, factor: 2.2, label: '超長距離（500km以上）',     isLongDistance: true  };
}

function buildDistanceMessage(distInfo) {
  let msg = `📏 推定距離：${distInfo.label}\n━━━━━━━━━━━━\n`;
  if (distInfo.isLongDistance) {
    msg += `⚠️ 長距離引越しのため、翌日配送となる場合があります。\n（前泊対応・中継料金が別途発生することがあります）`;
  } else {
    msg += `✅ 当日配送が可能なエリアです。`;
  }
  return msg;
}

async function sendFinalEstimate(replyToken, data) {
  const plan = data.plans.find(p => p.name === data.selectedPlan) || data.plans[0];
  const roadNote = (data.fromRoad === '4mより狭い' || data.toRoad === '4mより狭い')
    ? '\n⚠️ 道幅が狭いため、小型車対応費用が含まれています。' : '';

  await client.replyMessage(replyToken, [
    textMsg(
      `📋 お見積もり結果\n` +
      `━━━━━━━━━━━━\n` +
      `🏢 アップル引越センター\n` +
      `📦 プラン：${plan.name}\n` +
      `✨ ${plan.feature}\n` +
      `🚛 トラック：${plan.truck_type}\n` +
      `📏 距離：${data.distanceInfo.label}\n` +
      `━━━━━━━━━━━━\n` +
      `💴 お見積り金額\n` +
      `　${plan.price_range}（税込）` +
      roadNote + '\n' +
      `━━━━━━━━━━━━\n\n` +
      `✅ 担当者から24時間以内にご連絡します。\n` +
      `引越し頑張ってください！🎉\n\n` +
      `「リセット」で最初からやり直せます。`
    ),
  ]);
}

async function replyWelcome(replyToken) {
  await client.replyMessage(replyToken, [
    textMsg(
      `🏠 アップル引越センター\n見積もりアシスタントへようこそ！\n\n` +
      `各部屋の写真を送るだけで\nAIが荷物量を分析して\n最適なプランをご提案します。\n\n` +
      `まず、現在のお住まいの住所を教えてください。\n（例：東京都渋谷区）`
    ),
  ]);
}

function textMsg(text) { return { type: 'text', text }; }

function quickReply(text, options) {
  return {
    type: 'text', text,
    quickReply: {
      items: options.map(opt => ({
        type: 'action',
        action: { type: 'message', label: opt.slice(0, 20), text: opt },
      })),
    },
  };
}

async function getLineImage(messageId) {
  const response = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }, responseType: 'arraybuffer' }
  );
  return Buffer.from(response.data);
}

const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
