export interface RawAudio {
  channelData: Float32Array[];
  sampleRate: number;
}
export interface HTDemucsModel {
  sources: string[];
  audioChannels: number;
  samplerate: number;
  segment: number;
  validLength(length: number): number;
  forward(mix: { data: Float32Array; shape: readonly number[] }, magspec: { data: Float32Array; shape: readonly number[] }): Promise<{
    outX: { data: Float32Array; shape: readonly number[] };
    outXt: { data: Float32Array; shape: readonly number[] };
  }>;
}
export type ProgressCallback = (step: number, total: number) => void;
export declare function separateTracks(model: HTDemucsModel, rawAudio: RawAudio, progressCallback?: ProgressCallback, overlap?: number): Promise<Record<string, RawAudio>>;
