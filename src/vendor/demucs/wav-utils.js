// Vendored from demucs-js (MIT) — see ./LICENSE.md
export function planarize(channelData) {
    const channels = channelData.length;
    const samples = channelData[0].length;
    if (channels === 1) {
        return channelData[0];
    }
    else {
        let isSequential = true;
        for (let c = 1; c < channels; c++) {
            if (channelData[c].buffer !== channelData[0].buffer ||
                channelData[c].byteOffset !== channelData[c - 1].byteOffset + channelData[c - 1].length * 4) {
                isSequential = false;
                break;
            }
        }
        if (isSequential) {
            // Channels are sequential views of the same buffer, create a single view
            return new Float32Array(channelData[0].buffer, channelData[0].byteOffset, channels * samples);
        }
        else {
            // Channels are separate buffers, concatenate them
            let data = new Float32Array(channels * samples);
            for (let c = 0; c < channels; c++) {
                data.set(channelData[c], c * samples);
            }
            return data;
        }
    }
}
