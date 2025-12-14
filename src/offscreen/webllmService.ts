import { CreateMLCEngine, AppConfig } from "@mlc-ai/web-llm";
import { RJ_SYSTEM_PROMPT, SELECTED_MODEL } from "./constants";

const appConfig: AppConfig = {
  model_list: [
    {
      model: `https://huggingface.co/mlc-ai/${SELECTED_MODEL}`,
      model_id: SELECTED_MODEL,
      model_lib: `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_80/Llama-3_1-8B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm`,
    },
  ],
};

let engine: any = null;

async function getEngine() {
    if (engine) return engine;
    
    console.log("Initializing WebLLM Engine...");
    engine = await CreateMLCEngine(SELECTED_MODEL, { 
      appConfig,
      initProgressCallback: (report) => console.log("Hiring Cara RJ:", report.text)
    });
    return engine;
}

export async function generateWithWebLLM(data: { oldSongTitle: string; oldArtist: string; newSongTitle: string; newArtist: string; currentTime?: string }): Promise<string> {
    try {
        console.log("Using WebLLM Model:", SELECTED_MODEL);
        const engine = await getEngine();

        const timeContext = data.currentTime ? ` Current time: ${data.currentTime}.` : "";
        
        // Use consistent prompt
        const systemPrompt = RJ_SYSTEM_PROMPT + ` You are Cara, a high-energy radio DJ. Your output must be under 3 sentences. Be punchy, cool, and direct. Use the provided time to set the mood if relevant. No emojis. No intros like "Here is the transition".`;

        const currentTask = `Previous: "${data.oldSongTitle}" by ${data.oldArtist}\nNext: "${data.newSongTitle}" by ${data.newArtist}\n${timeContext}`;

        const reply = await engine.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Previous: "Hello" by Adele\nNext: "Levitating" by Dua Lipa` },
                { role: "assistant", content: "Adele keeping it deep with Hello. Now let's pick up the pace, here is Dua Lipa turning up the heat with Levitating!" },
                
                { role: "user", content: `Previous: "Hotel California" by Eagles\nNext: "Humble" by Kendrick Lamar` },
                { role: "assistant", content: "That was the legendary Eagles. We're switching lanes completely now—turn your volume up for Kendrick Lamar." },

                { role: "user", content: currentTask }
            ],

            temperature: 0.8, // Bump slightly for creativity
            top_p: 0.9,      // Helps variety
            repetition_penalty: 1.1, // CRITICAL for 1B models to stop loops
            max_tokens: 128,
        });

        console.log("WebLLM Response:", reply);
        return reply.choices[0].message.content || `Coming up: ${data.newSongTitle}.`;
    } catch (err) {
        console.error("WebLLM failed:", err);
        return `Next up: ${data.newSongTitle} by ${data.newArtist}. Let's go!`;
    }
}
