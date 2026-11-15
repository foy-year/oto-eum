export type Tensor = {
    data: Float32Array;
    shape: readonly number[];
};
export type ComplexTensor = {
    real: Tensor;
    imag: Tensor;
};
/**
 * Cooley-Tukey FFT algorithm
 */
export declare function fft(realInput: Float32Array, imagInput?: Float32Array | null): {
    real: Float32Array;
    imag: Float32Array;
};
/**
 * Inverse FFT
 */
export declare function ifft(realInput: Float32Array, imagInput: Float32Array): {
    real: Float32Array;
    imag: Float32Array;
};
export declare function hannWindow(n: number): Float32Array;
/**
 * Pad1d - matches Python's pad1d function
 */
export declare function pad1d(x: Tensor, paddings: number[], mode?: 'constant' | 'reflect'): Tensor;
/**
 * STFT - Short-Time Fourier Transform
 * Matches PyTorch's torch.stft behavior
 */
export declare function stft(x: Tensor, nFft: number, hopLength: number, window: Float32Array, normalized?: boolean, center?: boolean, padMode?: 'constant' | 'reflect'): ComplexTensor;
export declare function spectro(x: Tensor, nFft?: number, hopLength?: number | null): ComplexTensor;
export declare function spec(x: Tensor): ComplexTensor;
export declare function magnitude(z: ComplexTensor): Tensor;
/**
 * ISTFT - Inverse Short-Time Fourier Transform
 * Matches PyTorch's torch.istft behavior
 */
export declare function istft(z: ComplexTensor, nFft: number, hopLength: number, window: Float32Array, normalized?: boolean, length?: number | null, center?: boolean): Tensor;
export declare function ispectro(z: ComplexTensor, hopLength?: number | null, length?: number | null): Tensor;
export declare function ispec(z: ComplexTensor, length: number): Tensor;
