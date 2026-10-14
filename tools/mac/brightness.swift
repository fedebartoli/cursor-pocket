// Luminosita' dello schermo integrato: `cp-brightness get` stampa un valore tra 0 e 1; `cp-brightness set <0..1>` lo imposta.
// Usa DisplayServices (framework di sistema NON documentato da Apple): se in una versione futura di macOS sparisce, il
// comando esce con errore e il daemon semplicemente non cambia la luminosita'. Nessun permesso speciale.
import CoreGraphics
import Foundation

typealias GetFn = @convention(c) (UInt32, UnsafeMutablePointer<Float>) -> Int32
typealias SetFn = @convention(c) (UInt32, Float) -> Int32

guard let lib = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_NOW),
      let g = dlsym(lib, "DisplayServicesGetBrightness"),
      let s = dlsym(lib, "DisplayServicesSetBrightness") else {
  FileHandle.standardError.write("DisplayServices non disponibile\n".data(using: .utf8)!)
  exit(2)
}
let getBrightness = unsafeBitCast(g, to: GetFn.self)
let setBrightness = unsafeBitCast(s, to: SetFn.self)
let display = CGMainDisplayID()
let args = CommandLine.arguments

switch args.count > 1 ? args[1] : "" {
case "get":
  var v: Float = -1
  if getBrightness(display, &v) != 0 { exit(1) }
  print(String(format: "%.4f", v))
case "set":
  guard args.count > 2, let t = Float(args[2]), t >= 0, t <= 1 else { exit(64) }
  if setBrightness(display, t) != 0 { exit(1) }
default:
  FileHandle.standardError.write("uso: cp-brightness get | set <0..1>\n".data(using: .utf8)!)
  exit(64)
}
