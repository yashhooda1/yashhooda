import Foundation

struct Metar {
    let raw: String
    let category: String

    /// FAA flight categories from ceiling (feet AGL) and visibility (statute
    /// miles): the same four buckets the METAR Stream pipeline classifies into.
    /// The worse of the two governs.
    static func category(ceilingFt: Double?, visibilitySM: Double?) -> String {
        let ceiling = ceilingFt ?? .infinity
        let vis = visibilitySM ?? .infinity
        if ceiling < 500 || vis < 1 { return "LIFR" }
        if ceiling < 1000 || vis < 3 { return "IFR" }
        if ceiling <= 3000 || vis <= 5 { return "MVFR" }
        return "VFR"
    }

    /// Latest METAR from the NOAA Aviation Weather Center data API.
    static func latest(icao: String) async throws -> Metar? {
        let id = icao.trimmingCharacters(in: .whitespaces).uppercased()
        guard id.count == 4, id.allSatisfy({ $0.isLetter || $0.isNumber }) else { return nil }
        let url = URL(string: "https://aviationweather.gov/api/data/metar?ids=\(id)&format=json")!
        guard let list = try await HTTP.json(url) as? [[String: Any]], let obs = list.first,
              let raw = obs.string("rawOb") else { return nil }

        // Ceiling is the lowest broken, overcast or obscured layer.
        var ceiling: Double?
        for layer in (obs["clouds"] as? [[String: Any]]) ?? [] {
            guard let cover = layer.string("cover"), ["BKN", "OVC", "OVX"].contains(cover),
                  let base = layer.double("base") else { continue }
            ceiling = min(ceiling ?? base, base)
        }
        // Visibility arrives as a number, or as a string such as "10+".
        var vis = obs.double("visib")
        if vis == nil, let text = obs.string("visib") {
            vis = Double(text.replacingOccurrences(of: "+", with: ""))
        }
        return Metar(raw: raw, category: category(ceilingFt: ceiling, visibilitySM: vis))
    }
}
