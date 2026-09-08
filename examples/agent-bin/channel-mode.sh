# Shared transport selection. Auto preserves legacy fallback/broadcast behavior.
case "${FOREMAN_CHANNEL_MODE:-auto}" in
  auto) ;;
  mattermost) unset TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID ;;
  telegram) export MATTERMOST_BASE_URL= MATTERMOST_BOT_TOKEN= ;; # Override Bun's dotenv loading.
  *) echo 'FOREMAN_CHANNEL_MODE must be auto|mattermost|telegram' >&2; exit 2 ;;
esac
