import { MessageSchema, CurrentSong, UpcomingSong } from '../utils/types';
import { IntervalLogger } from '../utils/interval_logger';

// --- Constants ---

const INDICATOR_ID = 'ai-rj-mode-indicator';
const PLAY_PATH = "M5 4.623V19.38a1.5 1.5 0 002.26 1.29L22 12 7.26 3.33A1.5 1.5 0 005 4.623Z";

/**
 * Configuration constants for DOM selectors.
 */
const SELECTORS = {
  TITLE: '.song-title',
  ARTIST: '.byline'
} as const;

// --- State Variables ---

let upcomingSong: UpcomingSong | null = null;
let activeVideoElement: HTMLMediaElement | null = null;

// Sets to track processed songs
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

// --- Initialization ---

function init() {
    chrome.storage.sync.get(['isDebugEnabled', 'isEnabled'], (result) => {
        isDebug = result.isDebugEnabled ?? false;
        isEnabled = result.isEnabled ?? true;

        updateAIRJModeIndicator();
        
        // 1. Start the Heartbeat (Finds the right video)
        setInterval(ensureActiveVideoListener, 1000);
        
        // 2. Start Background Polling (Fetches metadata)
        startBackgroundPolling();
    });
}

// Listen for settings changes
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
    // Trust the active element if we have one
    if (activeVideoElement) return activeVideoElement.paused;
    
    // Fallback: Check all videos, return true only if ALL are paused
    const videos = Array.from(document.querySelectorAll('video'));
    return videos.every(v => v.paused);
};

export const click_play_pause = (): void => {
    const button = document.querySelector('#play-pause-button') as HTMLElement | null;
    if (button) button.click();
};

export const pauseSong = (): void => {
    if (activeVideoElement && !activeVideoElement.paused) {
        activeVideoElement.pause();
    } else {
        // Fallback: Click the button
        click_play_pause();
    }
};

export const resumeSong = (): void => {
    if (activeVideoElement && activeVideoElement.paused) {
        activeVideoElement.play().catch(e => log("Error playing media:", e));
    } else {
        click_play_pause();
    }
};

// --- Data Fetching ---

function getSongInfo(): CurrentSong {
    try {
        const video = activeVideoElement;
        
        let duration = 0;
        let currentTime = 0;
        let isPaused = true;

        if (video) {
            duration = Number.isFinite(video.duration) ? video.duration : 0;
            currentTime = video.currentTime; 
            isPaused = video.paused;
        }

        // Metadata
        const metadata = navigator.mediaSession?.metadata;
        let title = metadata?.title || "";
        let artist = metadata?.artist || "";
        let album = metadata?.album || "";

        // DOM Fallback
        if (!title) {
            title = document.querySelector('ytmusic-player-bar .title')?.textContent?.trim() || "";
            const byline = document.querySelector('ytmusic-player-bar .byline')?.textContent || "";
            const parts = byline.split('•').map(s => s.trim());
            artist = parts[0] || "";
            album = parts[1] || "";
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

// --- The Heartbeat (Video Discovery) ---

function ensureActiveVideoListener() {
    const videos = Array.from(document.querySelectorAll('video'));
    
    if (videos.length === 0) return;

    // FIND THE "TRUE" PLAYER:
    // 1. Must not be paused (highest priority)
    // 2. Or, has the highest currentTime (if everything is paused)
    const candidate = videos.reduce((prev, curr) => {
        if (!prev.paused && curr.paused) return prev;
        if (prev.paused && !curr.paused) return curr;
        return (curr.currentTime > prev.currentTime) ? curr : prev;
    });

    // If we found a new, better candidate, swap!
    if (candidate !== activeVideoElement) {
        log("🔄 Swapping active video listener", candidate);
        
        // Cleanup old listener
        if (activeVideoElement) {
            activeVideoElement.removeEventListener('timeupdate', handleTimeUpdate);
            // Remove visual debug border if exists
            activeVideoElement.style.border = '';
        }

        activeVideoElement = candidate;
        
        // Attach new listener
        activeVideoElement.addEventListener('timeupdate', handleTimeUpdate);
        
        // VISUAL DEBUG: Add a subtle red border to the tracked video in Debug mode
        if (isDebug) {
            activeVideoElement.style.border = '2px solid red';
        }
    }
}

// --- The Core Logic (Fires on Time Update) ---

function handleTimeUpdate() {
    if (!isEnabled || !activeVideoElement || activeVideoElement.paused) return;

    const duration = activeVideoElement.duration;
    const currentTime = activeVideoElement.currentTime;

    if (!Number.isFinite(duration)) return;

    const timeRemaining = duration - currentTime;
    const currentInfo = getSongInfo();
    
    if (!currentInfo.title) return;

    // Keying
    const nextTitle = upcomingSong?.title || "PENDING";
    const songKey = `${currentInfo.title}::${nextTitle}`;

    // Throttle logs
    if (isDebug) {
        interval_logger.log(`Active Video: ${timeRemaining.toFixed(2)}s left. Key: ${songKey}`);
    }

    // Cleanup
    if (prewarmedSongs.size > MAX_SET_SIZE) prewarmedSongs.clear();
    if (alertedSongs.size > MAX_SET_SIZE) alertedSongs.clear();

    // 1. PRE-WARM (at > 20%)
    if (duration > 0 && (currentTime / duration) > 0.2) {
        if (upcomingSong && !prewarmedSongs.has(songKey)) {
            log(`Pre-warming RJ model for ${songKey}`);
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

    // 2. THE TRIGGER (Pause at < 2.2s left)
    if (!alertedSongs.has(songKey)) {
        // Trigger Window: 2.2s to 0.2s
        // Min Duration: 10s (avoids short ads/glitches)
        if (timeRemaining <= 2.2 && timeRemaining > 0.2 && duration > 10) {
            
            log(`🔥 PAUSE TRIGGER HIT! Time left: ${timeRemaining.toFixed(3)}s`);
            
            pauseSong();
            alertedSongs.add(songKey);

            (async () => {
                // If we paused but don't have the next song yet, grab it now
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
    // Fetch immediately
    fetchUpcomingSong().then(data => { if(data) upcomingSong = data; });

    // Poll for metadata updates every 2s
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