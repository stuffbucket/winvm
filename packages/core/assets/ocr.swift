// winvm-ocr: recognise text in an image with macOS Vision.
// Prints one JSON object per line: {"text", "confidence", "box": [x, y, w, h]}
// in image pixels, origin top left — and, with --find, "match": the box of just
// the matched part of that line (Vision boxes substrings, so "Quit" inside
// "Quit Maximal" gets its own box). Lines without the text are left out.
//
// usage: winvm-ocr <image> [--find TEXT] [--fast]
// Built by ocr.ts on first use (swiftc -O) and cached by source hash.
import Foundation
import ImageIO
import Vision

let args = CommandLine.arguments
func fail(_ s: String) -> Never {
  FileHandle.standardError.write("winvm-ocr: \(s)\n".data(using: .utf8)!)
  exit(2)
}
guard args.count >= 2 else { fail("usage: winvm-ocr <image> [--find TEXT] [--fast]") }
let fast = args.contains("--fast")
var needle: String? = nil
if let i = args.firstIndex(of: "--find"), i + 1 < args.count { needle = args[i + 1] }

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
  let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
else { fail("cannot read \(args[1])") }
let W = Double(img.width)
let H = Double(img.height)

let req = VNRecognizeTextRequest()
req.recognitionLevel = fast ? .fast : .accurate
req.usesLanguageCorrection = !fast
do {
  try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
} catch {
  fail("recognition failed: \(error)")
}

func pixels(_ b: CGRect) -> [Int] {
  [Int((b.minX * W).rounded()), Int(((1 - b.maxY) * H).rounded()), Int((b.width * W).rounded()), Int((b.height * H).rounded())]
}

for o in req.results ?? [] {
  guard let c = o.topCandidates(1).first else { continue }
  var row: [String: Any] = ["text": c.string, "confidence": Double(c.confidence), "box": pixels(o.boundingBox)]
  if let n = needle {
    guard let r = c.string.range(of: n, options: [.caseInsensitive, .diacriticInsensitive]) else { continue }
    if let m = try? c.boundingBox(for: r) { row["match"] = pixels(m.boundingBox) }
  }
  let data = try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}
