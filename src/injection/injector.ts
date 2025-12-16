import { UpcomingSong } from "../utils/types";

// --- HELPER: Queue Logic (Keep your existing one) ---
function getNextSongData(): UpcomingSong | null {
  const queueEl = document.querySelector('ytmusic-player-queue') as any;
  const store = queueEl?.queue?.store || queueEl?.store;
  const state = store?.getState ? store.getState() : null;
  const queueState = state?.queue || state?.player?.queue;

  if (!queueState) return null;

  const mainItems = queueState.items || [];
  const automixItems = queueState.automixItems || [];
  const fullQueue = [...mainItems, ...automixItems];

  if (fullQueue.length === 0) return null;

  const unwrap = (item: any) => 
    item.playlistPanelVideoRenderer || 
    item.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;

  let currentIndex = -1;
  for (let i = 0; i < fullQueue.length; i++) {
    const data = unwrap(fullQueue[i]);
    if (data && data.selected) {
      currentIndex = i;
      break;
    }
  }

  if (currentIndex !== -1 && currentIndex < fullQueue.length - 1) {
    const nextData = unwrap(fullQueue[currentIndex + 1]);
    if (nextData) {
      return {
        title: nextData.title?.runs?.[0]?.text || "Unknown Title",
        artist: nextData.longBylineText?.runs?.[0]?.text || "Unknown Artist"
      };
    }
  }
  return null;
}

// --- HELPER: Player Status ---
function getPlayerStatus() {
  const player = document.getElementById('movie_player') as any;
  
  if (!player || typeof player.getCurrentTime !== 'function') {
    return null;
  }

  // The API handles offsets/music-video-padding for us
  const duration = player.getDuration();
  const currentTime = player.getCurrentTime();
  const timeLeft = duration - currentTime;
  
  // Player State: 1 = Playing, 2 = Paused, 3 = Buffering
  const state = player.getPlayerState();
  const isPaused = state === 2 || state === 0 || state === -1; // 0 is ended, -1 unstarted

  // Get current song details directly from API (More reliable than DOM)
  const videoData = player.getVideoData ? player.getVideoData() : null;

  return {
    timeLeft: timeLeft,
    currentTime: currentTime,
    duration: duration,
    isPaused: isPaused,
    currentTitle: videoData?.title || "Unknown",
    currentArtist: videoData?.author || "Unknown"
  };
}

// --- LISTENER ---
window.addEventListener('YTM_EXTENSION_REQUEST_STATUS', () => {
  const status = getPlayerStatus();
  const upcoming = getNextSongData();

  if (status) {
    window.dispatchEvent(new CustomEvent('YTM_EXTENSION_RETURN_STATUS', {
      detail: {
        ...status,
        upcoming // Attach upcoming song to the same packet
      }
    }));
  }
});