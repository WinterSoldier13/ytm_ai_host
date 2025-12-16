import { CurrentSong, UpcomingSong } from "../utils/types";

// --- STATE: Robust Timing (The Anchor Strategy) ---
// We track time relative to the song start, ignoring video.currentTime jumps
let playbackState = {
  duration: 0,
  anchorTime: 0,    // The video.currentTime when the logical song started
  logicalTime: 0,   // The calculated current time (0:00 -> 3:45)
  isInterrupted: false,
  currentVideoId: ''
};

// --- HELPER: Queue Logic (Unchanged) ---
function getNextSongData(): UpcomingSong | null {
  try {
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

    const currentIndex = fullQueue.findIndex((item: any) => {
        const d = unwrap(item);
        return d && d.selected;
    });

    if (currentIndex !== -1 && currentIndex < fullQueue.length - 1) {
      const nextData = unwrap(fullQueue[currentIndex + 1]);
      if (nextData) {
        return {
          title: nextData.title?.runs?.[0]?.text || "Unknown Title",
          artist: nextData.longBylineText?.runs?.[0]?.text || "Unknown Artist"
        };
      }
    }
  } catch (e) { console.error(e); }
  return null;
}

// --- CORE: Recalibrate & Watch ---
function setupRobustGuard() {
  const video = document.querySelector('video');
  const player = document.getElementById('movie_player') as any;

  if (!video || !player) {
    setTimeout(setupRobustGuard, 500); 
    return;
  }

  // 1. RECALIBRATE: Called on Seek or Song Change
  const recalibrate = () => {
    try {
      const vidData = player.getVideoData();
      if (!vidData) return;

      playbackState.duration = parseInt(vidData.lengthSeconds);
      playbackState.currentVideoId = vidData.video_id;
      
      // Formula: Anchor = RawVideoTime - LogicalTime(from API)
      playbackState.anchorTime = video.currentTime - player.getCurrentTime();
      playbackState.isInterrupted = false;
    } catch (e) { }
  };

  // Listen for song changes/seeks to reset the anchor
  player.addEventListener('onStateChange', (state: number) => {
      // -1 (Unstarted) or 5 (Cued) usually means new song
      if (state === -1 || state === 5) setTimeout(recalibrate, 200);
  });
  video.addEventListener('seeked', recalibrate);
  video.addEventListener('loadeddata', recalibrate);

  // 2. THE HEARTBEAT (Runs in background)
  video.addEventListener('timeupdate', () => {
    if (!playbackState.duration) return;

    // Calculate logical time based on Anchor
    const rawTime = video.currentTime;
    playbackState.logicalTime = rawTime - playbackState.anchorTime;
    
    // Safety clamp (0 to Duration)
    if (playbackState.logicalTime < 0) playbackState.logicalTime = 0;

    const timeLeft = playbackState.duration - playbackState.logicalTime;

    // --- INTERRUPT LOGIC (-2 Seconds) ---
    // We check here because content script polling is unreliable in background
    if (
      timeLeft <= 2 && 
      timeLeft > 0 && 
      !playbackState.isInterrupted && 
      !video.paused &&
      playbackState.duration > 10 // Ignore short clips/ads
    ) {
        video.pause();
        playbackState.isInterrupted = true;

        // Notify Content Script immediately
        document.dispatchEvent(new CustomEvent('YTM_EXTENSION_INTERRUPT_TRIGGER', {
            detail: {
                current: getPlayerStatus(), // Send the status snapshot
                upcoming: getNextSongData()
            }
        }));
    }
  });
}

// Start the guard
setupRobustGuard();


// --- HELPER: Player Status (Modified to use State) ---
function getPlayerStatus() : CurrentSong | null {
  const player = document.getElementById('movie_player') as any;
  const videoData = player?.getVideoData ? player.getVideoData() : null;

  if (!videoData) return null;

  function getAlbumFromDOM(): string {
    try {
      // Try MediaSession first (Cleanest)
      if (navigator.mediaSession?.metadata?.album) return navigator.mediaSession.metadata.album;
      
      // Fallback to DOM
      const byline = document.querySelector('ytmusic-player-bar .byline')?.textContent || "";
      const parts = byline.split('•').map(s => s.trim());
      return (parts.length >= 2) ? parts[1] : "";
    } catch (e) { return ""; }
  }

  // Use our Calculated State for time, fall back to API if state is empty
  const useDuration = playbackState.duration || player.getDuration();
  const useTime = playbackState.logicalTime; // Use the calculated time!

  return {
    title: videoData?.title || "Unknown Title",
    artist: videoData?.author || "Unknown Artist",
    album: getAlbumFromDOM(),
    duration: isNaN(useDuration) ? 0 : Math.floor(useDuration),
    currentTime: Math.floor(useTime), // Return the smooth logical time
    isPaused: (document.querySelector('video') as HTMLVideoElement)?.paused ?? true
  };
}


// --- LISTENER (For Polling) ---
document.addEventListener('YTM_EXTENSION_REQUEST_STATUS', () => {
  const current = getPlayerStatus();
  const upcoming = getNextSongData();

  if (current) {
    document.dispatchEvent(new CustomEvent('YTM_EXTENSION_RETURN_STATUS', {
      detail: { current, upcoming }
    }));
  }
});

// --- LISTENER (For Resume) ---
document.addEventListener('YTM_EXTENSION_RESUME_REQUEST', () => {
    const video = document.querySelector('video');
    if (video) {
        video.play();
        // Force interrupted to true to prevent double-firing on the tail end of the song
        playbackState.isInterrupted = true; 
    }
});