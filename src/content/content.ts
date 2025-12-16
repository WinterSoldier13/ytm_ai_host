import { MessageSchema, CurrentSong, UpcomingSong } from '../utils/types';
import { IntervalLogger } from '../utils/interval_logger';

// --- Constants ---

const INDICATOR_ID = 'ai-rj-mode-indicator';
const PLAY_PATH = "M5 4.623V19.38a1.5 1.5 0 002.26 1.29L22 12 7.26 3.33A1.5 1.5 0 005 4.623Z";

const SELECTORS = {
  TITLE: '.song-title',
  ARTIST: '.byline',
  // The time display: "2:30 / 3:56"
  TIME_INFO: '.time-info' 
} as const;

// --- State Variables ---

let upcomingSong: UpcomingSong | null = null;
let videoElement: HTMLMediaElement | null = null;

const prewarmedSongs = new Set<string>();
const alertedSongs = new Set<string>();
const MAX_SET_SIZE = 50;

let isDebug = false;
let isEnabled = true;

const interval_logger = new IntervalLogger(5000);

// --- Logging ---

function log(message: any, ...args: any[]) {
    if (!isDebug) return;
    if (message instanceof Error) {
        console.error("[AI-DJ]", message, ...args);
    } else {
        console.log("[AI-DJ]", message, ...args);
    }
}

// --- Helper: Time Parser ---

// Converts "3:56" or "1:02:30" to seconds
function parseTimeStr(timeStr: string): number {
    if (!timeStr) return 0;
    const parts = timeStr.trim().split(':').map(Number);
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
}

// --- Initialization ---

function init() {
    chrome.storage.sync.get(['isDebugEnabled', 'isEnabled'], (result) => {
        isDebug = result.isDebugEnabled ?? false;
        isEnabled = result.isEnabled ?? true;

        updateAIRJModeIndicator();
        
        setupVideoListener();
        startBackgroundPolling();
    });
}

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
        if (changes.isDebugEnabled) isDebug = changes.isDebugEnabled.newValue;
        if (changes.isEnabled) {
            isEnabled = changes.isEnabled.newValue;
            updateAIRJModeIndicator();
        }
    }
});

// --- UI Helpers ---

function updateAIRJModeIndicator() {
    const logoAnchor = document.querySelector('a.ytmusic-logo');
    if (!logoAnchor) return;

    let indicator = document.getElementById(INDICATOR_ID);

    if (isEnabled) {
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = INDICATOR_ID;
            indicator.innerText = 'AI RJ Mode';
            Object.assign(indicator.style, {
                fontSize: '10px',
                fontWeight: 'bold',
                color: '#fff',
                opacity: '0.7',
                position: 'absolute',
                bottom: '-12px',
                left: '0',
                width: '100%',
                textAlign: 'center',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
                fontFamily: 'Roboto, Arial, sans-serif'
            });
            const anchorStyle = window.getComputedStyle(logoAnchor);
            if (anchorStyle.position === 'static') {
                 (logoAnchor as HTMLElement).style.position = 'relative';
            }
            logoAnchor.appendChild(indicator);
        }
    } else if (indicator) {
        indicator.remove();
    }
}

// --- Playback Controls ---

export const isSongPaused = (): boolean => {
    if (videoElement) return videoElement.paused;
    const pathElement = document.querySelector('#play-pause-button yt-icon path');
    return pathElement?.getAttribute('d') === PLAY_PATH;
};

export const click_play_pause = (): void => {
    const button = document.querySelector('#play-pause-button') as HTMLElement | null;
    if (button) button.click();
};

export const pauseSong = (): void => {
    if (videoElement && !videoElement.paused) {
        videoElement.pause();
    } else if (!isSongPaused()) {
        click_play_pause();
    }
};

export const resumeSong = (): void => {
    if (videoElement && videoElement.paused) {
        videoElement.play().catch(e => log("Error playing media:", e));
    } else if (isSongPaused()) {
        click_play_pause();
    }
};

// --- Data Fetching ---

function getSongInfo(): CurrentSong {
    try {
        const video = document.querySelector('video') as HTMLMediaElement | null;
        
        let currentTime = 0;
        let duration = 0; // Will override this with DOM data
        let isPaused = true;

        if (video) {
            currentTime = video.currentTime; 
            isPaused = video.paused;
        }

        // 1. Metadata from MediaSession (Fastest)
        const metadata = navigator.mediaSession?.metadata;
        let title = metadata?.title || "";
        let artist = metadata?.artist || "";
        let album = metadata?.album || "";

        // 2. Metadata from DOM (Fallback & Duration Source)
        if (!title) {
            title = document.querySelector('ytmusic-player-bar .title')?.textContent?.trim() || "";
            const byline = document.querySelector('ytmusic-player-bar .byline')?.textContent || "";
            const parts = byline.split('•').map(s => s.trim());
            artist = parts[0] || "";
            album = parts[1] || "";
        }

        // 3. CRITICAL FIX: Get Duration from DOM text ("2:30 / 3:56")
        // We trust this visual duration over the video.duration
        const timeInfo = document.querySelector('.time-info')?.textContent?.trim();
        if (timeInfo) {
            const parts = timeInfo.split('/');
            if (parts.length === 2) {
                // Parse the second part ("3:56")
                const domDuration = parseTimeStr(parts[1]);
                if (domDuration > 0) {
                    duration = domDuration;
                }
            }
        }
        
        // Fallback: If DOM scrape failed, use video duration, but warn
        if (duration === 0 && video && Number.isFinite(video.duration)) {
            duration = video.duration;
        }

        return { title, artist, album, duration, currentTime, isPaused };

    } catch (e) {
        console.error('getSongInfo error', e);
        return { title: '', artist: '', album: '', duration: 0, currentTime: 0, isPaused: false };
    }
}

function fetchUpcomingSong(): Promise<UpcomingSong | null> {
  return new Promise((resolve) => {
    const handleResponse = (event: Event) => {
      const customEvent = event as CustomEvent;
      document.removeEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);
      resolve(customEvent.detail);
    };

    document.addEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);
    document.dispatchEvent(new CustomEvent('YTM_EXTENSION_REQUEST_DATA'));
    
    setTimeout(() => {
      document.removeEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);
      resolve(null);
    }, 1000);
  });
}

// --- The Core Engine ---

function setupVideoListener() {
    const video = document.querySelector('video');
    if (!video) {
        setTimeout(setupVideoListener, 500); 
        return;
    }
    
    if (videoElement === video) return;
    
    videoElement = video;
    log("✅ Attached AI DJ listener to video element.");

    video.addEventListener('timeupdate', handleTimeUpdate);
    
    video.addEventListener('emptied', () => {
        log("Video emptied. Re-checking...");
        setTimeout(setupVideoListener, 1000);
    });
}

function handleTimeUpdate() {
    if (!isEnabled || !videoElement || videoElement.paused) return;

    // Use getSongInfo() to get the DOM-based duration
    const currentInfo = getSongInfo();
    
    if (!currentInfo.title || currentInfo.duration === 0) return;

    // Calc time remaining using: (DOM Total Time) - (Video Current Time)
    const timeRemaining = currentInfo.duration - currentInfo.currentTime;

    const nextTitle = upcomingSong?.title || "PENDING";
    const songKey = `${currentInfo.title}::${nextTitle}`;

    if (isDebug) {
        interval_logger.log(`Time Left: ${timeRemaining.toFixed(3)}s | Key: ${songKey} | Dur: ${currentInfo.duration}`);
    }

    if (prewarmedSongs.size > MAX_SET_SIZE) prewarmedSongs.clear();
    if (alertedSongs.size > MAX_SET_SIZE) alertedSongs.clear();

    // --- PRE-WARM ---
    const progress = currentInfo.currentTime / currentInfo.duration;
    if (progress > 0.2) {
        if (upcomingSong && !prewarmedSongs.has(songKey)) {
            log(`Pre-warming for ${songKey}`);
            prewarmedSongs.add(songKey);
            
            chrome.runtime.sendMessage({
                type: 'PREWARM_RJ',
                payload: {
                    oldSongTitle: currentInfo.title,
                    oldArtist: currentInfo.artist,
                    newSongTitle: upcomingSong.title,
                    newArtist: upcomingSong.artist,
                    currentTime: new Date().toLocaleTimeString()
                }
            });
        }
    }

    // --- TRIGGER ---
    if (!alertedSongs.has(songKey)) {
        // Window: 2.2s to -5.0s (Negative allowed because video might run longer than DOM time)
        // Check upper bound (2.2s) and sane lower bound (e.g. -10s)
        if (timeRemaining <= 2.2 && timeRemaining > -10 && currentInfo.duration > 10) {
            
            log(`🔥 TIME HIT: ${timeRemaining.toFixed(3)}s remaining. PAUSING.`);
            
            pauseSong();
            alertedSongs.add(songKey);

            (async () => {
                if (!upcomingSong) {
                    log("Panic fetching next song...");
                    upcomingSong = await fetchUpcomingSong();
                }

                const message: MessageSchema = {
                    type: 'SONG_ABOUT_TO_END',
                    payload: {
                        currentSongTitle: currentInfo.title,
                        currentSongArtist: currentInfo.artist,
                        upcomingSongTitle: upcomingSong?.title || 'Unknown Song',
                        upcomingSongArtist: upcomingSong?.artist || 'Unknown Artist'
                    }
                };
                
                log("Sending Alert Message:", message);
                chrome.runtime.sendMessage(message);
            })();
        }
    }
}

// --- Background Tasks ---

function startBackgroundPolling() {
    log("Starting Background Polling...");
    fetchUpcomingSong().then(data => { if(data) upcomingSong = data; });

    setInterval(() => {
        if (!isSongPaused()) {
            fetchUpcomingSong().then(data => {
                if (data) upcomingSong = data;
            });
        }
    }, 2000);
}

// --- Message Listeners ---

chrome.runtime.onMessage.addListener((message: MessageSchema, sender, sendResponse) => {
    if (message.type === 'TTS_ENDED') {
        log("TTS Ended. Resuming.");
        if (isSongPaused()) {
            resumeSong();
        }
    }
    
    if (message.type === 'GET_CURRENT_SONG_INFO') {
        const current = getSongInfo();
        sendResponse({
            type: 'CURRENT_SONG_INFO',
            payload: {
                currentSongTitle: current.title,
                upcomingSongTitle: upcomingSong?.title || 'Unknown'
            }
        });
    }
});

// --- Boot ---

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}