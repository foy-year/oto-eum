// Vendored from demucs-js (MIT) — see ./LICENSE.md
import { spec, magnitude, ispec } from "./dsp.js";
import { planarize } from "./wav-utils.js";
class TensorChunk {
    tensor;
    offset;
    length;
    constructor(tensor, offset = 0, length = null) {
        const totalLength = tensor.shape[tensor.shape.length - 1];
        if (offset < 0)
            throw new Error('offset must be >= 0');
        if (offset >= totalLength)
            throw new Error('offset must be < totalLength');
        if (length === null) {
            length = totalLength - offset;
        }
        else {
            length = Math.min(totalLength - offset, length);
        }
        this.tensor = tensor;
        this.offset = offset;
        this.length = length;
    }
    padded(targetLength) {
        const delta = targetLength - this.length;
        const totalLength = this.tensor.shape[this.tensor.shape.length - 1];
        if (delta < 0)
            throw new Error('targetLength must be >= length');
        const start = this.offset - Math.floor(delta / 2);
        const end = start + targetLength;
        const correctStart = Math.max(0, start);
        const correctEnd = Math.min(totalLength, end);
        const padLeft = correctStart - start;
        const padRight = end - correctEnd;
        // Slice tensor from correctStart to correctEnd on last dimension
        // Then pad with zeros on left and right
        const shape = [...this.tensor.shape];
        const lastDim = shape.length - 1;
        shape[lastDim] = targetLength;
        // Calculate total size
        const totalSize = shape.reduce((a, b) => a * b, 1);
        const out = new Float32Array(totalSize);
        // Copy sliced data with padding
        // For multi-dimensional tensors, we need to handle each slice along the last dimension
        const sliceLength = correctEnd - correctStart;
        const innerSize = shape[lastDim]; // target length with padding
        const outerSize = totalSize / innerSize;
        for (let i = 0; i < outerSize; i++) {
            const srcOffset = i * totalLength + correctStart;
            const dstOffset = i * innerSize + padLeft;
            // Copy the valid slice
            for (let j = 0; j < sliceLength; j++) {
                out[dstOffset + j] = this.tensor.data[srcOffset + j];
            }
            // padLeft and padRight are already zeros (Float32Array is zero-initialized)
        }
        if (out.length !== totalSize) {
            throw new Error(`Output size mismatch: ${out.length} !== ${totalSize}`);
        }
        return {
            data: out,
            shape: shape,
        };
    }
}
/**
 * Pad to training length
 * Matches Python's F.pad(x, (0, training_length - x.shape[-1]))
 */
function padToTrainingLength(mix, trainingLength) {
    const currentLength = mix.shape[mix.shape.length - 1];
    if (currentLength >= trainingLength) {
        // No padding needed
        return mix;
    }
    const shape = [...mix.shape];
    shape[shape.length - 1] = trainingLength;
    const totalSize = shape.reduce((a, b) => a * b, 1);
    const out = new Float32Array(totalSize);
    // Copy existing data, zeros are already in place (Float32Array is zero-initialized)
    const outerSize = totalSize / trainingLength;
    for (let i = 0; i < outerSize; i++) {
        const srcOffset = i * currentLength;
        const dstOffset = i * trainingLength;
        for (let j = 0; j < currentLength; j++) {
            out[dstOffset + j] = mix.data[srcOffset + j];
        }
        // Remaining positions are already zero-padded
    }
    return { data: out, shape: shape };
}
function mask(m) {
    const [B, S, C, Fr, T] = m.shape;
    // C should be even (contains real and imag interleaved)
    const C_half = C / 2;
    // Output shape: [B, S, C//2, Fr, T] with real and imag
    const outShape = [B, S, C_half, Fr, T];
    const outSize = outShape.reduce((a, b) => a * b, 1);
    const realOut = new Float32Array(outSize);
    const imagOut = new Float32Array(outSize);
    // The input m has shape [B, S, C, Fr, T] where channels are [real0, imag0, real1, imag1, ...]
    // We need to convert to complex with shape [B, S, C//2, Fr, T]
    for (let b = 0; b < B; b++) {
        for (let s = 0; s < S; s++) {
            for (let c = 0; c < C_half; c++) {
                for (let fr = 0; fr < Fr; fr++) {
                    for (let t = 0; t < T; t++) {
                        // Input indices for real and imag channels
                        const realChannel = c * 2;
                        const imagChannel = c * 2 + 1;
                        const realInIdx = b * S * C * Fr * T + s * C * Fr * T + realChannel * Fr * T + fr * T + t;
                        const imagInIdx = b * S * C * Fr * T + s * C * Fr * T + imagChannel * Fr * T + fr * T + t;
                        // Output index
                        const outIdx = b * S * C_half * Fr * T + s * C_half * Fr * T + c * Fr * T + fr * T + t;
                        realOut[outIdx] = m.data[realInIdx];
                        imagOut[outIdx] = m.data[imagInIdx];
                    }
                }
            }
        }
    }
    return {
        real: { data: realOut, shape: outShape },
        imag: { data: imagOut, shape: outShape },
    };
}
function addTensors(a, b) {
    // Verify shapes match
    if (a.shape.length !== b.shape.length || !a.shape.every((dim, i) => dim === b.shape[i])) {
        throw new Error('Tensor shapes must match for addition');
    }
    const out = new Float32Array(a.data.length);
    for (let i = 0; i < a.data.length; i++) {
        out[i] = a.data[i] + b.data[i];
    }
    return { data: out, shape: [...a.shape] };
}
function cropToValidLength(x, validLength) {
    const shape = x.shape;
    const currentLength = shape[shape.length - 1];
    if (validLength >= currentLength) {
        // No cropping needed
        return x;
    }
    const newShape = [...shape];
    newShape[newShape.length - 1] = validLength;
    const totalSize = newShape.reduce((a, b) => a * b, 1);
    const out = new Float32Array(totalSize);
    const outerSize = totalSize / validLength;
    for (let i = 0; i < outerSize; i++) {
        for (let j = 0; j < validLength; j++) {
            const srcIdx = i * currentLength + j;
            const dstIdx = i * validLength + j;
            out[dstIdx] = x.data[srcIdx];
        }
    }
    return { data: out, shape: newShape };
}
function centerTrim(tensor, reference) {
    const tensorLength = tensor.shape[tensor.shape.length - 1];
    const refSize = reference; // reference is a number
    const delta = tensorLength - refSize;
    if (delta < 0) {
        throw new Error(`tensor must be larger than reference. Delta is ${delta}.`);
    }
    if (delta === 0) {
        // No trimming needed
        return tensor;
    }
    // Calculate trim indices
    const start = Math.floor(delta / 2);
    const end = tensorLength - (delta - Math.floor(delta / 2));
    const shape = [...tensor.shape];
    const newLength = end - start;
    shape[shape.length - 1] = newLength;
    const totalSize = shape.reduce((a, b) => a * b, 1);
    const out = new Float32Array(totalSize);
    const outerSize = totalSize / newLength;
    for (let i = 0; i < outerSize; i++) {
        for (let j = 0; j < newLength; j++) {
            const srcIdx = i * tensorLength + start + j;
            const dstIdx = i * newLength + j;
            out[dstIdx] = tensor.data[srcIdx];
        }
    }
    return { data: out, shape: shape };
}
async function applyInference(model, mix) {
    const length = mix.length;
    const validLength = model.validLength(length);
    const paddedMix = mix.padded(validLength);
    const trainingLength = Math.floor(model.segment * model.samplerate);
    // Pad to training length
    const paddedPaddedMix = padToTrainingLength(paddedMix, trainingLength);
    // Compute spectrogram
    const z = spec(paddedPaddedMix);
    // Compute magnitude spectrogram
    const magspec = magnitude(z);
    // Run model forward
    const { outX, outXt } = await model.forward(paddedMix, magspec);
    // Convert mask to complex
    const zout = mask(outX);
    // Inverse spectrogram
    const timeFromSpec = ispec(zout, trainingLength);
    // Add time and frequency branches
    const sumBeforeCrop = addTensors(outXt, timeFromSpec);
    // Crop to valid length
    const out = cropToValidLength(sumBeforeCrop, validLength);
    // Center trim to original chunk length
    return centerTrim(out, length);
}
/**
 * Split input into segments and apply model to each segment
 */
async function applySplits(model, mix, progressCallback, overlap = 0.25) {
    const [batch, channels, length] = mix.shape;
    // Initialize output arrays
    const sources = model.sources.length;
    const outData = new Float32Array(batch * sources * channels * length);
    const sumWeight = new Float32Array(length);
    const segment = Math.floor(model.samplerate * model.segment);
    const stride = Math.floor((1 - overlap) * segment);
    // Create triangle-shaped weight for smooth transitions
    const weight = new Float32Array(segment);
    for (let i = 0; i < Math.floor(segment / 2) + 1; i++) {
        weight[i] = i + 1;
    }
    for (let i = Math.floor(segment / 2) + 1; i < segment; i++) {
        weight[i] = segment - i;
    }
    const maxWeight = weight.reduce((max, current) => Math.max(max, current), -Infinity);
    for (let i = 0; i < segment; i++) {
        weight[i] /= maxWeight;
    }
    const total = Math.ceil(length / stride);
    progressCallback?.(0, total);
    // Process each chunk
    let offset = 0;
    let chunkIndex = 0;
    while (offset < length) {
        const chunk = new TensorChunk(mix, offset, segment);
        const chunkOut = await applyInference(model, chunk);
        const chunkLength = chunkOut.shape[chunkOut.shape.length - 1];
        // Add weighted chunk to output
        for (let b = 0; b < batch; b++) {
            for (let s = 0; s < sources; s++) {
                for (let c = 0; c < channels; c++) {
                    for (let t = 0; t < chunkLength; t++) {
                        const outIdx = b * sources * channels * length + s * channels * length + c * length + offset + t;
                        const chunkIdx = b * sources * channels * chunkLength + s * channels * chunkLength + c * chunkLength + t;
                        // oto-eum modification: a non-finite sample at a segment edge contributes
                        // nothing (the overlapping segment covers it) instead of poisoning the sum
                        const v = chunkOut.data[chunkIdx];
                        outData[outIdx] += weight[t] * (Number.isFinite(v) ? v : 0);
                    }
                }
            }
        }
        // Add weights
        for (let t = 0; t < chunkLength; t++) {
            sumWeight[offset + t] += weight[t];
        }
        offset += stride;
        chunkIndex++;
        progressCallback?.(chunkIndex, total);
    }
    // Normalize by sum of weights
    for (let i = 0; i < outData.length; i++) {
        const timeIdx = i % length;
        outData[i] /= sumWeight[timeIdx];
    }
    return {
        data: outData,
        shape: [batch, sources, channels, length],
    };
}
async function applyModel(model, mix, progressCallback, overlap = 0.25) {
    // TODO: implement random shifts
    return await applySplits(model, mix, progressCallback, overlap);
}
export async function separateTracks(model, rawAudio, progressCallback, overlap = 0.25) {
    const { channelData, sampleRate } = rawAudio;
    const channels = channelData.length;
    const samples = channelData[0].length;
    const data = planarize(rawAudio.channelData);
    const mix = {
        data,
        shape: [1, channels, samples],
    };
    const result = await applyModel(model, mix, progressCallback, overlap);
    const [batch, sources, resultChannels, length] = result.shape;
    // Extract each source
    const tracks = {};
    for (let s = 0; s < sources; s++) {
        const sourceName = model.sources[s];
        const channelData = [];
        for (let c = 0; c < channels; c++) {
            const startIdx = s * channels * length + c * length;
            const channelArray = new Float32Array(result.data.buffer, startIdx * 4, // byte offset (Float32 = 4 bytes)
            length);
            channelData.push(channelArray);
        }
        tracks[sourceName] = { channelData, sampleRate };
    }
    return tracks;
}
