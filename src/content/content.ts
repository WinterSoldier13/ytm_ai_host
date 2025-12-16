import { MessageSchema, CurrentSong, UpcomingSong } from '../utils/types';
import { IntervalLogger } from '../utils/interval_logger';

// --- Constants ---

const INDICATOR_ID = 'ai-rj-mode-indicator';

// --- State Variables ---

// We just store whatever the injector gave us last
let lastStatus: any = null;

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
        
        // Start the Polling Engine (500ms is fast enough for 2s precision)
        setInterval(pollInjector, 500);
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

export const click_play_pause = (): void => {
    const button = document.querySelector('#play-pause-button') as HTMLElement | null;
    if (button) button.click();
};

export const pauseSong = (): void => {
    // Try High-Level Button first (safest for YTM state)
    click_play_pause();
    
    // Safety Net: Force pause video element if button missed
    setTimeout(() => {
        const video = document.querySelector('video.html5-main-video') as HTMLMediaElement;
        if (video && !video.paused) video.pause();
    }, 50);
};

export const resumeSong = (): void => {
    click_play_pause();
};

// --- Polling Engine ---

function pollInjector() {
    if (!isEnabled) return;

    const handleResponse = (event: Event) => {
        const customEvent = event as CustomEvent;
        document.removeEventListener('YTM_EXTENSION_RETURN_STATUS', handleResponse);
        processStatus(customEvent.detail);
    };

    document.addEventListener('YTM_EXTENSION_RETURN_STATUS', handleResponse);
    document.dispatchEvent(new CustomEvent('YTM_EXTENSION_REQUEST_STATUS'));
}

function processStatus(data: any) {
    if (!data) return;
    
    lastStatus = data;
    
    const { 
        timeLeft, 
        duration, 
        currentTime, 
        isPaused, 
        currentTitle, 
        currentArtist, 
        upcoming 
    } = data;

    // Safety check for weird data
    if (duration < 10) return; 
    if (isPaused) return;

    const nextTitle = upcoming?.title || "PENDING";
    const songKey = `${currentTitle}::${nextTitle}`;

    if (isDebug) {
        interval_logger.log(`Injector TimeLeft: ${timeLeft.toFixed(3)}s | Key: ${songKey}`);
    }

    // Cleanup memory
    if (prewarmedSongs.size > MAX_SET_SIZE) prewarmedSongs.clear();
    if (alertedSongs.size > MAX_SET_SIZE) alertedSongs.clear();

    // --- LOGIC A: PRE-WARM ( > 20% progress ) ---
    // Note: currentTime / duration check
    if ((currentTime / duration) > 0.2) {
        if (upcoming && !prewarmedSongs.has(songKey)) {
            log(`Pre-warming RJ model for ${songKey}`);
            prewarmedSongs.add(songKey);
            
            chrome.runtime.sendMessage({
                type: 'PREWARM_RJ',
                payload: {
                    oldSongTitle: currentTitle,
                    oldArtist: currentArtist,
                    newSongTitle: upcoming.title,
                    newArtist: upcoming.artist,
                    currentTime: new Date().toLocaleTimeString()
                }
            });
        }
    }

    // --- LOGIC B: THE TRIGGER ( < 2.2s left ) ---
    if (!alertedSongs.has(songKey)) {
        // We trust 'timeLeft' from injector implicitly now.
        // It accounts for offsets, start times, and logic that 'video.currentTime' misses.
        if (timeLeft <= 2.2 && timeLeft > 0.1) {
            
            log(`🔥 TRIGGER HIT! TimeLeft: ${timeLeft.toFixed(3)}s. PAUSING.`);
            
            pauseSong();
            alertedSongs.add(songKey);

            const message: MessageSchema = {
                type: 'SONG_ABOUT_TO_END',
                payload: {
                    currentSongTitle: currentTitle,
                    currentSongArtist: currentArtist,
                    upcomingSongTitle: upcoming?.title || 'Unknown Song',
                    upcomingSongArtist: upcoming?.artist || 'Unknown Artist'
                }
            };
            
            log("Sending Alert Message:", message);
            chrome.runtime.sendMessage(message);
        }
    }
}

// --- Message Listeners ---

chrome.runtime.onMessage.addListener((message: MessageSchema, sender, sendResponse) => {
    if (message.type === 'TTS_ENDED') {
        log("TTS Ended. Resuming.");
        // We can check our cached state
        if (lastStatus && lastStatus.isPaused) {
            resumeSong();
        } else {
            // Fallback if cache stale
            resumeSong();
        }
    }
    
    if (message.type === 'GET_CURRENT_SONG_INFO') {
        // Return cached info immediately
        sendResponse({
            type: 'CURRENT_SONG_INFO',
            payload: {
                currentSongTitle: lastStatus?.currentTitle || "Unknown",
                upcomingSongTitle: lastStatus?.upcoming?.title || 'Unknown'
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