import {
  CurrentSong,
  UpcomingSong,
  EVENT_TRIGGER,
  EVENT_UPDATE,
  EVENT_RESUME,
  EVENT_REQUEST_DATA,
  EVENT_RETURN_DATA,
  EVENT_TTS_STARTED,
} from "../utils/types";

(() => {
  // --- CONFIG --- (Imported from types)

  // Immediate startup log
  console.log(
    "%c[Injector] Script Loaded & Running",
    "color: #bada55; font-size: 12px; font-weight: bold;",
  );

  // --- STATE ---
  let isLocked = false;
  let safetyTimer: any = null;
  let currentTitle = "";
  let latestUpcomingTitle = ""; // To detect queue updates

  const mediaSession = navigator.mediaSession;
  const originalPlay = HTMLMediaElement.prototype.play;

  const log = (msg: string, ...args: any[]) =>
    console.log(`%c[Injector] ${msg}`, "color: #bada55", ...args);

  // --- 1. HELPER: Internal Data Access ---
  function getNextSongData(): UpcomingSong | null {
    const queueEl = document.querySelector("ytmusic-player-queue") as any;
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
      item.playlistPanelVideoWrapperRenderer?.primaryRenderer
        ?.playlistPanelVideoRenderer;

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
          artist: nextData.longBylineText?.runs?.[0]?.text || "Unknown Artist",
        };
      }
    }
    return null;
  }

  function getPlayerStatus(): CurrentSong | null {
    try {
      const player = document.getElementById("movie_player") as any;
      const videoData = player?.getVideoData ? player.getVideoData() : null;
      const metadata = navigator.mediaSession?.metadata;

      // Prefer MediaSession for Title/Artist/Album as it matches what user sees
      let title = metadata?.title || videoData?.title || "";
      let artist = metadata?.artist || videoData?.author || "";
      let album = metadata?.album || "";

      // Fallback for album from DOM if missing (MediaSession often has it though)
      if (!album) {
        const byline =
          document.querySelector("ytmusic-player-bar .byline")?.textContent ||
          "";
        const parts = byline.split("•").map((s) => s.trim());
        if (parts.length > 1) album = parts[1];
      }

      const isPaused = player?.getPlayerState
        ? player.getPlayerState() === 2
        : true;

      return {
        title,
        artist,
        album,
        isPaused,
      };
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // --- 2. BROADCASTER ---

  function broadcast(eventType: string, reason?: string, extras?: any) {
    const currentSong = getPlayerStatus();
    const upcomingSong = getNextSongData();

    if (currentSong) {
      log(`Broadcasting ${eventType} (${reason})`, {
        current: currentSong.title,
        next: upcomingSong?.title,
        ...extras,
      });

      document.dispatchEvent(
        new CustomEvent(eventType, {
          detail: {
            currentSong,
            upcomingSong,
            reason,
            timestamp: Date.now(),
            ...extras,
          },
        }),
      );

      // Update local state to detect changes later
      currentTitle = currentSong.title;
      latestUpcomingTitle = upcomingSong?.title || "";
    } else {
      log(`Skipping broadcast ${eventType}: No active player found.`);
    }
  }

  // Smart Pause: Extend lock when TTS starts
  document.addEventListener(EVENT_TTS_STARTED, () => {
    log("TTS Started Signal (DOM). Extending Safety Lock to 30s.");
    if (safetyTimer) clearTimeout(safetyTimer);
    // 30s emergency unlock
    safetyTimer = setTimeout(() => {
      log("Safety Unlock Triggered (Extended 30s) - TTS took too long?");
      if (isLocked) {
        isLocked = false;
        broadcast(EVENT_RESUME, "SAFETY_TIMER_LONG");
        const v = document.querySelector("video, audio") as HTMLMediaElement;
        if (v) originalPlay.call(v);
      }
    }, 30000);
  });

  // --- 3. THE PLAY LOCK & TRAP ---

  // Override play to enforce pause during transition
  HTMLMediaElement.prototype.play = function (): Promise<void> {
    if (isLocked) {
      log("Play blocked pending API check");
      return Promise.resolve();
    }
    return originalPlay.apply(this);
  };

  let _metadata = mediaSession.metadata;
  Object.defineProperty(mediaSession, "metadata", {
    get() {
      return _metadata;
    },
    set(newValue) {
      _metadata = newValue;

      if (newValue && newValue.title !== currentTitle) {
        // Always Lock & Pause immediately on song change
        log(
          `Song Change Detected from "${currentTitle}" to "${newValue.title}"`,
        );

        isLocked = true;
        const video = document.querySelector(
          "video, audio",
        ) as HTMLMediaElement;
        if (video) video.pause();

        // Safety Unlock Timer (in case Content Script is dead or misses event)
        if (safetyTimer) clearTimeout(safetyTimer);
        const timerStart = Date.now();
        safetyTimer = setTimeout(() => {
          const elapsed = Date.now() - timerStart;
          if (elapsed > 8000) {
            log(
              `Safety Timer delayed significantly by browser throttling (${elapsed}ms). Tab might be backgrounded.`,
            );
          }

          if (isLocked) {
            log("Safety Unlock Triggered - Resume signal missed?");
            isLocked = false;
            broadcast(EVENT_RESUME, "SAFETY_TIMER"); // Notify content to cancel announcements
            const v = document.querySelector(
              "video, audio",
            ) as HTMLMediaElement;
            if (v) originalPlay.call(v);
          }
        }, 6000);

        // Broadcast the event
        broadcast(EVENT_TRIGGER, "SONG_CHANGED");
      }
    },
    configurable: true,
  });

  // --- 4. LISTENERS ---

  // Listen for resume command from Content Script
  document.addEventListener(EVENT_RESUME, () => {
    log("Resume Event Received");
    if (safetyTimer) clearTimeout(safetyTimer);
    isLocked = false;
    const video = document.querySelector("video, audio") as HTMLMediaElement;
    if (video) originalPlay.call(video);
  });

  // Listen for data requests (e.g. on startup)
  document.addEventListener(EVENT_REQUEST_DATA, () => {
    broadcast(EVENT_RETURN_DATA, "REQUESTED");

    // If we are locked when content connects, it means they missed the TRIGGER.
    // Resend it so they can handle it (or resume us).
    if (isLocked) {
      log("Content connected while Locked. Re-sending TRIGGER.");
      broadcast(EVENT_TRIGGER, "RECONNECT_RETRY");
    }
  });

  // --- 5. POLLING FOR QUEUE UPDATES ---
  // Sometimes the queue loads *after* the song starts, or updates while playing.
  // We check periodically if the "Upcoming" song has changed.

  setInterval(() => {
    const next = getNextSongData();
    const nextTitle = next?.title || "";

    // If upcoming song changed (and we are not currently locked/changing), notify content
    if (nextTitle !== latestUpcomingTitle) {
      log(`Queue update detected: ${latestUpcomingTitle} -> ${nextTitle}`);
      broadcast(EVENT_UPDATE, "QUEUE_UPDATED");
    }
  }, 2000);
})();
