import AppKit
import Foundation

// macOS displays the artwork silhouette; the exported icon already carries its own
// rounded dark tile, so only the standard 96px canvas margin is added here.
guard CommandLine.arguments.count == 3,
      let artwork = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let image = artwork.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let context = CGContext(
        data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ) else {
    fatalError("Unable to load Formicand artwork or create the icon canvas")
}

context.setAllowsAntialiasing(true)
context.setShouldAntialias(true)
let side: CGFloat = 832
context.interpolationQuality = .high
context.draw(
    image,
    in: CGRect(x: (1024 - side) / 2, y: (1024 - side) / 2, width: side, height: side)
)

guard let rendered = context.makeImage(),
      let png = NSBitmapImageRep(cgImage: rendered).representation(using: .png, properties: [:]) else {
    fatalError("Unable to encode the Formicand app icon")
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
