import AVFoundation
import OrbiDesktopCore

// The mic, open only while talking: AVAudioEngine converted to PCM s16le
// 16 kHz mono in ~20 ms chunks. Before a hold is confirmed the chunks are
// kept here (at most 10 s); stream() sends them and everything after.
@MainActor
final class Mic {
  var onChunk: (Data) -> Void = { _ in }

  private var engine: AVAudioEngine?
  private var pending: [Data] = []
  private var pendingBytes = 0
  private var streaming = false
  private let maxPendingBytes = Int(Proto.micSampleRate) * 2 * 10

  var isOpen: Bool { engine != nil }

  func open() {
    guard engine == nil, Perms.mic else { return }
    let e = AVAudioEngine()
    let input = e.inputNode
    let inFormat = input.outputFormat(forBus: 0)
    guard inFormat.sampleRate > 0,
          let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Proto.micSampleRate, channels: 1, interleaved: true),
          let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
      log("mic: no usable input format")
      return
    }
    let ratio = Proto.micSampleRate / inFormat.sampleRate
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(inFormat.sampleRate / 50), format: inFormat) { [weak self] buf, _ in
      let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio + 32)
      guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
      var fed = false
      var err: NSError?
      converter.convert(to: out, error: &err) { _, status in
        if fed { status.pointee = .noDataNow; return nil }
        fed = true
        status.pointee = .haveData
        return buf
      }
      guard err == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }
      let data = Data(bytes: ch[0], count: Int(out.frameLength) * 2)
      Task { @MainActor in self?.chunk(data) }
    }
    do {
      try e.start()
      engine = e
    } catch {
      input.removeTap(onBus: 0)
      log("mic: could not start (\(error.localizedDescription))")
    }
  }

  func stream() {
    streaming = true
    for d in pending { onChunk(d) }
    pending = []
    pendingBytes = 0
  }

  func close() {
    engine?.inputNode.removeTap(onBus: 0)
    engine?.stop()
    engine = nil
    streaming = false
    pending = []
    pendingBytes = 0
  }

  private func chunk(_ d: Data) {
    guard engine != nil else { return }
    if streaming { onChunk(d); return }
    pending.append(d)
    pendingBytes += d.count
    while pendingBytes > maxPendingBytes, !pending.isEmpty { pendingBytes -= pending.removeFirst().count }
  }
}

// TTS playback: PCM s16le 24 kHz mono frames from the server, queued on an
// AVAudioPlayerNode. stop() cuts it at once (barge-in).
@MainActor
final class Player {
  private let engine = AVAudioEngine()
  private let node = AVAudioPlayerNode()
  private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Proto.ttsSampleRate, channels: 1, interleaved: false)!
  private var carry: UInt8?
  private var ready = false

  init() {
    engine.attach(node)
    engine.connect(node, to: engine.mainMixerNode, format: format)
  }

  func play(_ pcm: Data) {
    var bytes = [UInt8](pcm)
    if let c = carry { bytes.insert(c, at: 0); carry = nil }
    if bytes.count % 2 == 1 { carry = bytes.removeLast() }
    let frames = bytes.count / 2
    guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
          let out = buf.floatChannelData?[0] else { return }
    buf.frameLength = AVAudioFrameCount(frames)
    for i in 0..<frames {
      let s = Int16(bitPattern: UInt16(bytes[2 * i]) | (UInt16(bytes[2 * i + 1]) << 8))
      out[i] = Float(s) / 32768
    }
    if !ready {
      do { try engine.start(); ready = true } catch {
        log("player: could not start (\(error.localizedDescription))")
        return
      }
    }
    node.scheduleBuffer(buf, completionHandler: nil)
    if !node.isPlaying { node.play() }
  }

  func stop() {
    carry = nil
    guard ready else { return }
    node.stop()
  }
}
