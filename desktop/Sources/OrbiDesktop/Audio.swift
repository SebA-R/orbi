@preconcurrency import AVFoundation
import OrbiDesktopCore
import QuartzCore

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
  private var change: NSObjectProtocol?

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
      // A device change (headphones in or out) stops the engine: reopen on
      // the new device, keeping the stream going.
      change = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: e, queue: .main) { [weak self] _ in
        Task { @MainActor in
          guard let self, self.engine === e else { return }
          let wasStreaming = self.streaming
          self.close()
          self.open()
          if wasStreaming { self.stream() }
        }
      }
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
    if let change { NotificationCenter.default.removeObserver(change) }
    change = nil
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
// AVAudioPlayerNode. stop() cuts it at once (barge-in). After a local stop
// (the user pressed the talk key) frames still in flight are dropped until
// the server's audio_stop arrives, or for 3 s at most, so the cut-off reply
// does not start again. play() says when the frame will be heard, for the
// overlay's karaoke and lip-sync: buffers play back to back, so like
// lib/voice/tts.js it keeps a play head, plus the output's latency.
@MainActor
final class Player {
  private let engine = AVAudioEngine()
  private let node = AVAudioPlayerNode()
  private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Proto.ttsSampleRate, channels: 1, interleaved: false)!
  private var carry: UInt8?
  private var wired = false
  private var mutedUntil: Date?
  private var playHead: CFTimeInterval = 0

  private func wire() {
    guard !wired else { return }
    wired = true
    engine.attach(node)
    engine.connect(node, to: engine.mainMixerNode, format: format)
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      Task { @MainActor in self?.node.stop(); self?.playHead = 0 } // started again on the next frame
    }
  }

  // The frame's samples and how far from now it starts to be heard, or nil
  // when it is not played.
  @discardableResult
  func play(_ pcm: Data) -> (samples: Int, inSeconds: Double)? {
    var bytes = [UInt8](pcm)
    if let until = mutedUntil {
      if Date() < until { return nil }
      mutedUntil = nil
    }
    if let c = carry { bytes.insert(c, at: 0); carry = nil }
    if bytes.count % 2 == 1 { carry = bytes.removeLast() }
    let frames = bytes.count / 2
    guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
          let out = buf.floatChannelData?[0] else { return nil }
    buf.frameLength = AVAudioFrameCount(frames)
    for i in 0..<frames {
      let s = Int16(bitPattern: UInt16(bytes[2 * i]) | (UInt16(bytes[2 * i + 1]) << 8))
      out[i] = Float(s) / 32768
    }
    wire()
    if !engine.isRunning {
      do { try engine.start() } catch {
        log("player: could not start (\(error.localizedDescription))")
        return nil
      }
    }
    node.scheduleBuffer(buf, completionHandler: nil)
    if !node.isPlaying { node.play() }
    let now = CACurrentMediaTime()
    let start = max(playHead, now)
    playHead = start + Double(frames) / Proto.ttsSampleRate
    return (frames, start - now + engine.outputNode.presentationLatency)
  }

  // local: the user barged in; the server's audio_stop is still to come.
  func stop(local: Bool) {
    carry = nil
    mutedUntil = local ? Date().addingTimeInterval(3) : nil
    playHead = 0
    if wired { node.stop() }
  }
}
