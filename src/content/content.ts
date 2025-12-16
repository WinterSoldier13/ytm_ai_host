import { MessageSchema, CurrentSong, UpcomingSong } from '../utils/types';
import { IntervalLogger } from '../utils/interval_logger';

// --- Constants ---

const INDICATOR_ID = 'ai-rj-mode-indicator';
const PLAY_PATH = "M5 4.623V19.38a1.5 1.5 0 002.26 1.29L22 12 7.26 3.33A1.5 1.5 0 005 4.623Z";

// Target the main video player specifically
const VIDEO_SELECTOR = 'video.html5-main-video';

const SELECTORS = {
  TITLE: '.song-title',
  ARTIST: '.byline'
} as const;

// --- State Variables ---

let upcomingSong: UpcomingSong | null = null;
let officialDuration: number = 0; // The source of truth from Injector
let videoElement: HTMLMediaElement | null = null;

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
        
        // 1. Start Fast Event Loop (Video Time Updates)
        setupVideoListener();
        
        // 2. Start Slow Data Loop (Sync Duration/Metadata from Injector)
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
    if (videoElement) return videoElement.paused;
    const pathElement = document.querySelector('#play-pause-button yt-icon path');
    return pathElement?.getAttribute('d') === PLAY_PATH;
};

export const click_play_pause = (): void => {
    const button = document.querySelector('#play-pause-button') as HTMLElement | null;
    if (button) button.click();
    else log(new Error("Could not find #play-pause-button"));
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

// Requests both the upcoming song AND the correct duration from Injector
function fetchSyncData(): Promise<{ upcoming: UpcomingSong | null, duration: number } | null> {
  return new Promise((resolve) => {
    const handleResponse = (event: Event) => {
      const customEvent = event as CustomEvent;
      document.removeEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);
      resolve(customEvent.detail);
    };

    document.addEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);
    document.dispatchEvent(new CustomEvent('YTM_EXTENSION_REQUEST_DATA'));
    
    // Timeout
    setTimeout(() => {
      document.removeEventListener('YTM_EXTENSION_RETURN_DATA', handleResponse);
      resolve(null);
    }, 1000);
  });
}

function getSongInfo(): CurrentSong {
    try {
        const video = document.querySelector(VIDEO_SELECTOR) as HTMLMediaElement | null;
        
        let currentTime = 0;
        let isPaused = true;

        if (video) {
            currentTime = video.currentTime; 
            isPaused = video.paused;
        }

        // 1. Metadata (MediaSession is fastest)
        const metadata = navigator.mediaSession?.metadata;
        let title = metadata?.title || "";
        let artist = metadata?.artist || "";
        let album = metadata?.album || "";

        // 2. DOM Fallback
        if (!title) {
            title = document.querySelector(SELECTORS.TITLE)?.textContent?.trim() || "";
            const byline = document.querySelector(SELECTORS.ARTIST)?.textContent || "";
            // Parse "Artist • Album • Year"
            const parts = byline.split('•').map(s => s.trim());
            artist = parts[0] || "";
            album = parts[1] || "";
        }

        // 3. DURATION LOGIC
        // Priority 1: Official Duration from Injector (Fixed Value)
        // Priority 2: Video Duration (Fallback, might be wrong for Music Videos)
        const finalDuration = (officialDuration > 0) ? officialDuration : (video?.duration || 0);

        return { 
            title, 
            artist, 
            album, 
            duration: Number.isFinite(finalDuration) ? finalDuration : 0, 
            currentTime, 
            isPaused 
        };

    } catch (e) {
        console.error('getSongInfo error', e);
        return { title: '', artist: '', album: '', duration: 0, currentTime: 0, isPaused: false };
    }
}

// --- The Core Engine ---

function setupVideoListener() {
    const video = document.querySelector(VIDEO_SELECTOR) as HTMLMediaElement;
    
    if (!video) {
        setTimeout(setupVideoListener, 500); 
        return;
    }
    
    if (videoElement === video) return;
    
    if (videoElement) {
        videoElement.removeEventListener('timeupdate', handleTimeUpdate);
    }

    videoElement = video;
    log("✅ Attached AI DJ listener to MAIN video element.");

    video.addEventListener('timeupdate', handleTimeUpdate);
    
    // If YTM swaps the player, re-attach
    video.addEventListener('emptied', () => {
        log("Video emptied. Re-checking...");
        setTimeout(setupVideoListener, 1000);
    });
}

function handleTimeUpdate() {
    if (!isEnabled || !videoElement || videoElement.paused) return;

    // Use cached Official Duration if available
    const duration = officialDuration > 0 ? officialDuration : videoElement.duration;
    const currentTime = videoElement.currentTime;

    if (!Number.isFinite(duration)) return;

    // CALCULATE PRECISE TIME LEFT
    // Because 'duration' is the Official Song Length, subtracting 'currentTime'
    // gives us the real countdown to the UI's 0:00, ignoring any hidden video outro.
    const timeRemaining = duration - currentTime;

    const currentInfo = getSongInfo();
    if (!currentInfo.title) return;

    // Keying
    const nextTitle = upcomingSong?.title || "PENDING";
    const songKey = `${currentInfo.title}::${nextTitle}`;

    if (isDebug) {
        interval_logger.log(`Left: ${timeRemaining.toFixed(3)}s | Key: ${songKey} | OfficialDur: ${officialDuration.toFixed(1)}`);
    }

    // Cleanup memory
    if (prewarmedSongs.size > MAX_SET_SIZE) prewarmedSongs.clear();
    if (alertedSongs.size > MAX_SET_SIZE) alertedSongs.clear();

    // --- LOGIC A: PRE-WARM ---
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

    // --- LOGIC B: THE TRIGGER ---
    if (!alertedSongs.has(songKey)) {
        // Trigger if:
        // 1. We are within 2.2s of the Official End
        // 2. OR: We have gone PAST the Official End (currentTime > duration)
        //    (This handles "Music Video" outros where video plays longer than song)
        // 3. AND: The song has played for at least 10s (prevents triggers on skipped tracks)
        if ((timeRemaining <= 2.2 && timeRemaining > -5) || (currentTime >= duration)) {
            if (duration > 10) { // Sane duration check
                
                log(`🔥 TRIGGER HIT! TimeLeft: ${timeRemaining.toFixed(3)}s. PAUSING.`);
                
                pauseSong();
                alertedSongs.add(songKey);

                (async () => {
                    // Final check for next song data
                    if (!upcomingSong) {
                        const data = await fetchSyncData();
                        if (data) {
                            upcomingSong = data.upcoming;
                            officialDuration = data.duration;
                        }
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
}

// --- Background Tasks ---

function startBackgroundPolling() {
    log("Starting Sync...");
    
    const sync = () => {
        // Only fetch if playing (saves resources)
        if (!isSongPaused()) {
            fetchSyncData().then(data => { 
                if(data) {
                    upcomingSong = data.upcoming;
                    // Update our "Source of Truth" for duration
                    if (data.duration > 0) officialDuration = data.duration;
                }
            });
        }
    };

    sync(); // Initial fetch
    setInterval(sync, 2000); // Loop every 2s
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