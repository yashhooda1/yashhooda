import Foundation
import Observation

/// One NOAA station from the ClimatePulse gold layer.
struct Station: Identifiable, Hashable {
    struct Year: Identifiable, Hashable {
        let year: Int
        let meanF: Double
        let trendF: Double?
        var id: Int { year }
    }

    let code: String
    let name: String
    let slopePerDecade: Double?
    let trendReliable: Bool
    let lastDataDate: String?
    let stale: Bool
    let years: [Year]
    var id: String { code }
}

/// Loads https://www.yashhooda.ai/api/climate, the same endpoint the web
/// dashboard reads. The payload is keyed by station code and also carries
/// pipeline metadata (generated_at, stations_summary, ...), so it is decoded by
/// hand: any top-level object with a `yearly` array is a station.
@Observable
final class ClimateStore {
    static let endpoint = URL(string: "https://www.yashhooda.ai/api/climate")!

    var stations: [Station] = []
    var generatedAt: String?
    var isSeedFallback = false
    var isLoading = false
    var error: String?

    @MainActor
    func load() async {
        isLoading = true
        error = nil
        defer { isLoading = false }
        do {
            guard let root = try await HTTP.json(Self.endpoint) as? [String: Any] else {
                throw HTTP.Failure.badPayload
            }
            generatedAt = root["generated_at"] as? String
            isSeedFallback = (root["seed_fallback"] as? Bool) ?? false
            let order = (root["station_codes"] as? [String]) ?? root.keys.sorted()
            var parsed: [Station] = []
            for code in order {
                guard let obj = root[code] as? [String: Any],
                      let yearly = obj["yearly"] as? [[String: Any]] else { continue }
                let years: [Station.Year] = yearly.compactMap { row in
                    guard let year = row.double("year"), let mean = row.double("avg_tmean") else { return nil }
                    return Station.Year(year: Int(year), meanF: mean, trendF: row.double("trend"))
                }
                guard !years.isEmpty else { continue }
                parsed.append(Station(
                    code: code,
                    name: obj.string("name") ?? code,
                    slopePerDecade: obj.double("slope_annual"),
                    trendReliable: (obj["trend_reliable"] as? Bool) ?? true,
                    lastDataDate: obj.string("last_data_date"),
                    stale: (obj["stale"] as? Bool) ?? false,
                    years: years.sorted { $0.year < $1.year }
                ))
            }
            if parsed.isEmpty { throw HTTP.Failure.badPayload }
            stations = parsed
        } catch {
            self.error = error.localizedDescription
        }
    }
}
