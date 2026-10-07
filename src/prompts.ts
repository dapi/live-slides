import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

/** What a presentation may change about the director and the recognizer; empty means the default. */
export interface TalkSettings {
  director_prompt: string;
  talk_brief: string;
  speech_terms: string;
}

/** Upper bounds for the project fields; the form and the API share them. */
export const TALK_LIMITS = { director_prompt: 12000, talk_brief: 2000, speech_terms: 600 } as const;

function read(name: string): string {
  const path = join(config.promptsDir, name);
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!text) throw new Error("пустой файл");
    return text;
  } catch (error) {
    throw new Error(`Не удалось прочитать промпт ${path}: ${(error as Error).message}`);
  }
}

/**
 * The shipped prompts, read once at start from PROMPTS_DIR. An installation changes them
 * by pointing at another directory; a presentation overrides its own copy in the database.
 */
export const prompts = {
  /** The slide director's system prompt. */
  director: read("director.md"),
  /** Added to the director's prompt in the paths mode. */
  paths: read("paths.md"),
  /** The recognizer's hint: terms and the style of speech it should expect. */
  speechTerms: read("speech-terms.txt"),
};

/** The director's system prompt for one talk: the project's own or the shipped one, plus the brief. */
export function directorPrompt(talk?: Partial<TalkSettings>): string {
  const base = talk?.director_prompt?.trim() || prompts.director;
  const brief = talk?.talk_brief?.trim();
  return brief ? `${base}\n\nО выступлении, от докладчика:\n${brief}` : base;
}

export function speechTerms(talk?: Partial<TalkSettings>): string {
  return talk?.speech_terms?.trim() || prompts.speechTerms;
}
