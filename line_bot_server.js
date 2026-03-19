// ============================================================
// 引越し見積もりLINEボット - メインサーバー
// Node.js + Express
// ============================================================

const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();

// ---- 環境変数（.envに設定） ----
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const client = new line.Client(config);

// ---- セッション管理（本番はRedis推奨） ----
const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { step: 'welcome', data: {} };
  }
  return sessions[userId];
}

// ============================================================
// Webhook受信
// ============================================================
app.post('/webhook', line.middleware(config), async (req, res) => {
  res.sendStatus(200); // LINEに即200返す（タイムアウト防止）
  
  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
});

async function handleEvent(event) {
  const userId = event.source.userId;
  const session = getSession(userId);

  // テキストメッセージ
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    await handleText(userId, text, session, event.replyToken);
  }

  // 画像メッセージ
  if (event.type === 'message' && event.message.type === 'image') {
    await handleImage(userId, event.message.id, session, event.replyToken);
  }
}

// ============================================================
// テキスト処理 - ステップ管理
// ============================================================
async function handleText(userId, text, session, replyToken) {
  const { step, data } = session;

  // どのステップでも「リセット」で最初から
  if (text === 'リセット' || text === 'やり直す') {
    sessions[userId] = { step: 'welcome', data: {} };
    await replyWelcome(replyToken);
    return;
  }

  switch (step) {
    case 'welcome':
      await replyWelcome(replyToken);
      session.step = 'ask_from';
      break;

    case 'ask_from':
      data.from = text;
      session.step = 'ask_to';
      await client.replyMessage(replyToken, [
        textMsg(`📍 引越し元：${text}\n\nでは、**引越し先の住所**を教えてください。\n（例：東京都港区）`),
      ]);
      break;

    case 'ask_to':
      data.to = text;
      session.step = 'ask_family';
      await client.replyMessage(replyToken, [
        textMsg(`📍 引越し先：${text}\n\n次に、**ご家族の人数・構成**を教えてください。`),
        quickReply('家族構成を選んでください', [
          '一人暮らし', '夫婦2人', '3人家族', '4人以上'
        ]),
      ]);
      break;

    case 'ask_family':
      data.family = text;
      session.step = 'ask_photo';
      await client.replyMessage(replyToken, [
        textMsg(
          `✅ 確認内容\n` +
          `━━━━━━━━━━━━\n` +
          `📦 引越し元：${data.from}\n` +
          `🏠 引越し先：${data.to}\n` +
          `👨‍👩‍👧 家族構成：${data.family}\n` +
          `━━━━━━━━━━━━\n\n` +
          `最後に、**各部屋の写真**を送ってください 📸\n` +
          `AIが荷物量を自動で分析します。\n\n` +
          `（リビング・寝室・キッチンなど、全部屋分送ってください）`
        ),
      ]);
      break;

    case 'ask_photo':
      await client.replyMessage(replyToken, [
        textMsg('📸 写真を送ってください！\nテキストではなく画像ファイルで送ってもらえますか？'),
      ]);
      break;

    case 'select_company':
      data.selectedCompany = text;
      session.step = 'done';
      await sendFinalEstimate(replyToken, data);
      break;

    default:
      await replyWelcome(replyToken);
      session.step = 'ask_from';
  }
}

// ============================================================
// 画像処理 - Claude Vision APIで荷物分析
// ============================================================
async function handleImage(userId, messageId, session, replyToken) {
  const { step, data } = session;

  if (step !== 'ask_photo') {
    await client.replyMessage(replyToken, [
      textMsg('今は写真は受け付けていません。\n「リセット」と送ると最初からやり直せます。'),
    ]);
    return;
  }

  // 受信中メッセージ
  await client.replyMessage(replyToken, [
    textMsg('📸 写真を受け取りました！\n🔍 AIが荷物を分析中です...\n少々お待ちください（10〜20秒）'),
  ]);

  try {
    // LINE APIから画像取得
    const imageBuffer = await getLineImage(messageId);
    const base64Image = imageBuffer.toString('base64');

    // Claude Vision APIで分析
    const analysis = await analyzeWithClaude(base64Image, data);
    data.analysis = analysis;

    // トラック候補を計算
    const trucks = calcTrucks(analysis.volume_m3, data.from, data.to);
    data.trucks = trucks;

    session.step = 'select_company';

    // 結果を送信
    await client.pushMessage(userId, [
      textMsg(
        `🎯 分析完了！\n` +
        `━━━━━━━━━━━━\n` +
        `📦 検出した荷物：${analysis.item_count}点\n` +
        `📐 推定荷物量：${analysis.volume_m3}㎥\n` +
        `🏠 部屋規模：${analysis.room_size}\n` +
        `━━━━━━━━━━━━\n\n` +
        `${analysis.summary}`
      ),
      textMsg(
        `🚛 おすすめトラック\n` +
        `━━━━━━━━━━━━\n` +
        trucks.map((t, i) =>
          `${i + 1}. ${t.company}\n` +
          `   ${t.truck_type}\n` +
          `   目安料金：${t.price_range}\n`
        ).join('\n') +
        `━━━━━━━━━━━━\n` +
        `どの会社に正式見積もりを依頼しますか？`
      ),
      quickReply('会社を選んでください', trucks.map(t => t.company)),
    ]);

  } catch (err) {
    console.error('Analysis error:', err);
    await client.pushMessage(userId, [
      textMsg('⚠️ 分析中にエラーが発生しました。\nもう一度写真を送ってみてください。'),
    ]);
  }
}

// ============================================================
// Claude Vision API - 荷物分析
// ============================================================
async function analyzeWithClaude(base64Image, userData) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64Image },
        },
        {
          type: 'text',
          text: `あなたは引越し専門の荷物量査定AIです。
この部屋の写真を見て、以下をJSON形式で返してください。

家族構成: ${userData.family}

{
  "item_count": 検出した家具・荷物の点数(数字),
  "volume_m3": 推定総荷物量(㎥、数字),
  "room_size": "1K" or "1LDK" or "2LDK" or "3LDK" など,
  "truck_size": "軽トラ" or "2t" or "3t" or "4t" or "大型",
  "summary": "荷物の概要を2〜3文で（日本語）",
  "notes": "特記事項があれば（大型家具・ピアノ等）"
}

JSONのみ返してください。説明文は不要です。`,
        },
      ],
    }],
  });

  const raw = response.content[0].text.trim();
  // JSON部分だけ抽出
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch[0]);
}

// ============================================================
// 料金計算ロジック（実際はAPI連携に置き換え）
// ============================================================
function calcTrucks(volumeM3, from, to) {
  // 距離係数（本来はGoogle Maps APIで算出）
  const distanceFactor = estimateDistance(from, to);
  
  // 荷物量でトラックサイズ決定
  let basePrice, truckType;
  if (volumeM3 <= 5) {
    basePrice = 35000; truckType = '軽トラック';
  } else if (volumeM3 <= 10) {
    basePrice = 55000; truckType = '2tトラック';
  } else if (volumeM3 <= 18) {
    basePrice = 85000; truckType = '3tトラック';
  } else {
    basePrice = 110000; truckType = '4tトラック';
  }

const companies = [
    { company: 'アップル引越センター', rating: '⭐5.0', feature: '梱包材無料' },
    { company: 'アップル引越センター', rating: '⭐5.0', feature: '家具組立付き' },
    { company: 'アップル引越センター', rating: '⭐5.0', feature: '保険充実' },
];

  return companies.map((c, i) => {
    const multiplier = [1.0, 1.08, 1.15][i];
    const price = Math.round(basePrice * distanceFactor * multiplier / 1000) * 1000;
    return {
      ...c,
      truck_type: truckType,
      price_range: `¥${price.toLocaleString()}〜`,
      base_price: price,
    };
  });
}

function estimateDistance(from, to) {
  // 簡易距離係数（本番はGoogle Maps Distance Matrix API）
  if (from === to) return 1.0;
  const same_pref = from.slice(0, 3) === to.slice(0, 3);
  return same_pref ? 1.2 : 1.6;
}

// ============================================================
// 最終見積もり送信
// ============================================================
async function sendFinalEstimate(replyToken, data) {
  const company = data.trucks.find(t => t.company === data.selectedCompany)
    || data.trucks[0];

  await client.replyMessage(replyToken, [
    textMsg(
      `📋 正式見積もり\n` +
      `━━━━━━━━━━━━\n` +
      `🏢 業者：${company.company}\n` +
      `🚛 トラック：${company.truck_type}\n` +
      `📦 荷物量：${data.analysis.volume_m3}㎥\n` +
      `━━━━━━━━━━━━\n` +
      `💴 お見積り金額\n` +
      `　${company.price_range}（税込）\n` +
      `━━━━━━━━━━━━\n\n` +
      `✅ 担当者から24時間以内にご連絡します。\n\n` +
      `「リセット」で最初からやり直せます。`
    ),
  ]);
}

// ============================================================
// ヘルパー関数
// ============================================================
async function replyWelcome(replyToken) {
  await client.replyMessage(replyToken, [
    textMsg(
      `🏠 引越し見積もりアシスタントへようこそ！\n\n` +
      `写真を送るだけで、AIが荷物量を分析して\n` +
      `最適な引越しプランを提案します。\n\n` +
      `まず、**引越し元の住所**を教えてください。\n（例：東京都渋谷区）`
    ),
  ]);
}

function textMsg(text) {
  return { type: 'text', text };
}

function quickReply(text, options) {
  return {
    type: 'text',
    text,
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
    {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
      responseType: 'arraybuffer',
    }
  );
  return Buffer.from(response.data);
}

// ============================================================
// サーバー起動
// ============================================================
const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
