import { selftest, configured } from "../src/notify/telegram.mjs";
const r = await selftest();
if (!configured()) {
  console.log("Telegram is not configured.\n");
  console.log("To set it up:");
  console.log("  1. Message @BotFather on Telegram → /newbot → copy the token");
  console.log("  2. Message your new bot once (it cannot message you first)");
  console.log("  3. Open https://api.telegram.org/bot<TOKEN>/getUpdates");
  console.log("     and copy result[0].message.chat.id");
  console.log("  4. Put both in .env as TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  process.exit(1);
}
console.log(r.ok ? `Connected as @${r.bot} — check the chat for a test message.` : `Not connected: ${r.reason}`);
process.exit(r.ok ? 0 : 1);
