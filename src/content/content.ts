import { MessageSchema, CurrentSong, UpcomingSong } from '../utils/types';
import { IntervalLogger } from '../utils/interval_logger';

// --- Constants ---

const musicBarXPath = '/html/body/ytmusic-app/ytmusic-app-layout/ytmusic-player-bar/div[2]';
const PLAY_PATH = "M5 4.623V19.38a1.5 1.5 0 002.26 1.29L22 12 7.26 3.33A1.5 1.5 0 005 4.623Z";
const INDICATOR_ID = 'ai-rj-mode-indicator';

const interval_logger = new IntervalLogger(5000);

// --- State Variables ---
let currentSong: CurrentSong | null = null;
let upcomingSong: UpcomingSong | null = null;

// Sets to track processed songs.
const prewarmedSongs = new Set<string>();
const alertedSongs = new Set<string>();
const MAX_SET_SIZE = 50;

let isDebug = false;
let isEnabled = true;
let isFirstSong = true;

// --- Logging & Debugging ---

function log(message: any, ...args: any[]) {
    if (!isDebug) return;
    if (message instanceof Error) {
        console.error(message, ...args);
    } else {
        console.log(message, ...args);
    }
}

// Initialize state and start polling
function init() {
    chrome.storage.sync.get(['isDebugEnabled', 'isEnabled'], (result) => {
        isDebug = result.isDebugEnabled ?? false;
        isEnabled = result.isEnabled ?? true;

        updateAIRJModeIndicator();

        // Start polling only after we have the initial settings
        startPolling();
    });
}

// Listen for changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
        if (changes.isDebugEnabled) {
            isDebug = changes.isDebugEnabled.newValue;
        }
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

            indicator.style.fontSize = '10px';
            indicator.style.fontWeight = 'bold';
            indicator.style.color = '#fff';
            indicator.style.opacity = '0.7';
            indicator.style.position = 'absolute';
            indicator.style.bottom = '-12px';
            indicator.style.left = '0';
            indicator.style.width = '100%';
            indicator.style.textAlign = 'center';
            indicator.style.pointerEvents = 'none';
            indicator.style.whiteSpace = 'nowrap';
            indicator.style.fontFamily = 'Roboto, Noto Naskh Arabic UI, Arial, sans-serif';

            const anchorStyle = window.getComputedStyle(logoAnchor);
            if (anchorStyle.position === 'static') {
                (logoAnchor as HTMLElement).style.position = 'relative';
            }

            logoAnchor.appendChild(indicator);
        }
    } else {
        if (indicator) {
            indicator.remove();
        }
    }
}

export const isSongPaused = (): boolean => {
    const media = document.querySelector('video, audio') as HTMLMediaElement | null;
    if (media) {
        return media.paused;
    }
    const pathElement = document.querySelector('#play-pause-button yt-icon path');

    if (!pathElement) {
        // log(new Error("Play/Pause button path not found in DOM."));
        return false;
    }

    const currentPath = pathElement.getAttribute('d');
    return currentPath === PLAY_PATH;
};

export const click_play_pause = (): void => {
    const button = document.querySelector('#play-pause-button') as HTMLElement | null;
    if (button) {
        button.click();
    } else {
        log(new Error("Could not find #play-pause-button"));
    }
};

export const resumeSong = (): void => {
    // 1. Ask Injector to resume (Cleanest way)
    document.dispatchEvent(new CustomEvent('YTM_EXTENSION_RESUME_REQUEST'));

    if (isSongPaused()) {
        const media = document.querySelector('video, audio') as HTMLMediaElement | null;
        if (media) {
            log("Injector resume failed, attempting media.play()...");
            media.play().catch((err) => {
                log("media.play() also failed:", err);
            });
        }
    }

    // 2. Fallback: Check if it actually worked, if not, force click
    setTimeout(() => {
        if (isSongPaused()) {
            log("Injector resume failed, forcing DOM click...");
            click_play_pause();
        }
    }, 200);
}

export const pauseSong = (): void => {
    const media = document.querySelector('video, audio') as HTMLMediaElement | null;
    if (media && !media.paused) {
        log("Pausing via media.pause()...");
        media.pause();
        return;
    }

    if (!isSongPaused()) {
        log("Pausing via DOM click...");
        click_play_pause();
    }
};


// --- CORE: Data Fetching ---

function fetchSongs(): Promise<{ currentSong: CurrentSong; upcomingSong: UpcomingSong } | null> {
    return new Promise((resolve) => {
        // 1. Set up a one-time listener for the response
        const handleResponse = (event: Event) => {
            const customEvent = event as CustomEvent;
            document.removeEventListener('YTM_EXTENSION_RETURN_STATUS', handleResponse);
            resolve(customEvent.detail);
        };

        document.addEventListener('YTM_EXTENSION_RETURN_STATUS', handleResponse);

        // 2. Dispatch the request
        document.dispatchEvent(new CustomEvent('YTM_EXTENSION_REQUEST_STATUS'));

        // Optional: Timeout if injector doesn't respond
        setTimeout(() => {
            document.removeEventListener('YTM_EXTENSION_RETURN_STATUS', handleResponse);
            resolve(null);
        }, 1000);
    });
}


// --- CORE: Polling Loop (Status & Pre-warming) ---

function get_status() {
    updateAIRJModeIndicator();

    // If Chrome extension is disabled
    if (!isEnabled) return;

    fetchSongs().then(data => {
        if (data) {
            currentSong = data.currentSong;
            upcomingSong = data.upcomingSong;
        } else {
            upcomingSong = null;
        }

        if (!currentSong) return;

        // Logging
        if (isDebug) {
            interval_logger.log(`--- Status Check --- ${currentSong.title} [${currentSong.currentTime}/${currentSong.duration}] ---`);
        }

        if (currentSong.title === '') return;

        // Was it the first song?
        if (isFirstSong) {
            log("This was the first song", currentSong);
            isFirstSong = false;
        }

        if (!upcomingSong) return;

        // --- PRE-WARMING LOGIC ---
        // We only handle "Pre-warming" in the polling loop.
        // The "Pause/End" logic is now event-driven (see below).

        const songKey = currentSong.title + "::" + upcomingSong.title;

        // Cleanup memory
        if (prewarmedSongs.size > MAX_SET_SIZE) prewarmedSongs.clear();
        if (alertedSongs.size > MAX_SET_SIZE) alertedSongs.clear();

        const progress = currentSong.duration > 0 ? (currentSong.currentTime / currentSong.duration) : 0;
        interval_logger.log(`Timestamps - Current: ${currentSong.currentTime}s / ${currentSong.duration}s | Progress: ${(progress * 100).toFixed(2)}%`);
        if (progress > 0.2 && !prewarmedSongs.has(songKey)) {

            log(`Song > 20%. Pre-warming RJ model for key: ${songKey}`);
            prewarmedSongs.add(songKey);

            const message: MessageSchema = {
                type: 'PREWARM_RJ',
                payload: {
                    oldSongTitle: currentSong.title,
                    oldArtist: currentSong.artist,
                    newSongTitle: upcomingSong.title,
                    newArtist: upcomingSong.artist,
                    currentTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                }
            };
            chrome.runtime.sendMessage(message);
        }
    });
}

// --- NEW: Event Listener for Precise Interruption ---
// This is triggered by the Injector when it pauses the video at -2s
document.addEventListener('YTM_EXTENSION_INTERRUPT_TRIGGER', (event: Event) => {
    const customEvent = event as CustomEvent;
    const { current, upcoming } = customEvent.detail;

    // Update local state immediately with the data from the event
    currentSong = current;
    upcomingSong = upcoming;

    if (!currentSong || !upcomingSong) return;

    const songKey = currentSong.title + "::" + upcomingSong.title;

    // Safety check: Don't alert twice for the same song pair
    if (alertedSongs.has(songKey)) return;

    log(`[EVENT] Injector triggered pause. Sending SONG_ABOUT_TO_END for: ${songKey}`);
    alertedSongs.add(songKey);

    const message: MessageSchema = {
        type: 'SONG_ABOUT_TO_END',
        payload: {
            currentSongTitle: currentSong.title,
            currentSongArtist: currentSong.artist,
            upcomingSongTitle: upcomingSong.title,
            upcomingSongArtist: upcomingSong.artist
        }
    };
    chrome.runtime.sendMessage(message);
});


function startPolling() {
    log("Starting Polling...");
    // Poll every 1 second just for UI updates and Pre-warming
    setInterval(get_status, 1000);
}

// --- Message Listeners ---

chrome.runtime.onMessage.addListener((message: MessageSchema, sender, sendResponse) => {
    if (message.type === 'TTS_ENDED') {
        log("TTS Ended. Attempting to resume song.");
        // We trust isSongPaused() or just force resume logic
        if (isSongPaused()) {
            resumeSong();
        } else {
            log("TTS Ended, but song is already playing. Skipping resume.");
        }
    }
});

// Someone requested current song info
chrome.runtime.onMessage.addListener((message: MessageSchema, sender, sendResponse) => {
    if (message.type === 'GET_CURRENT_SONG_INFO') {
        log("Received request to validate current song info.");

        // We can just use the cached state from the last poll/event
        const response: MessageSchema = {
            type: 'CURRENT_SONG_INFO',
            payload: {
                currentSongTitle: currentSong?.title || '',
                upcomingSongTitle: upcomingSong?.title || 'Unknown'
            }
        };
        sendResponse(response);
    }
});

// Start watching
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}