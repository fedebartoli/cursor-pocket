// Built-in screen brightness: `cp-brightness get` prints a value between 0 and 1; `cp-brightness set <0..1>` sets it.
// Uses DisplayServices (Apple-undocumented system framework): if it disappears in a future macOS version, the
// command exits with an error and the daemon simply does not change brightness. No special permission.
import CoreGraphics
import Foundation

typealias GetFn = @convention(c) (UInt32, UnsafeMutablePointer<Float>) -> Int32
typealias SetFn = @convention(c) (UInt32, Float) -> Int32

guard let lib = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_NOW),
      let g = dlsym(lib, "DisplayServicesGetBrightness"),
      let s = dlsym(lib, "DisplayServicesSetBrightness") else {
  FileHandle.standardError.write("DisplayServices unavailable\n".data(using: .utf8)!)
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
  FileHandle.standardError.write("usage: cp-brightness get | set <0..1>\n".data(using: .utf8)!)
  exit(64)
}
