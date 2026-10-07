import Foundation
import SwiftData

/// One logged flight. A personal training record for a hobby, not an official
/// logbook: the paper or endorsed electronic logbook stays the record of truth.
@Model
final class Flight {
    var date: Date
    var aircraftType: String
    var tailNumber: String
    var departure: String
    var arrival: String
    var totalHours: Double
    var dualHours: Double
    var soloHours: Double
    var dayLandings: Int
    var nightLandings: Int
    var maneuvers: [String]
    var notes: String
    /// Raw METAR for the departure airport, captured when the flight was logged.
    var metarRaw: String?
    var flightCategory: String?
    /// Drafted on-device from `notes`. Editable; never sent anywhere.
    var debrief: String?

    init(date: Date = .now, aircraftType: String = "", tailNumber: String = "",
         departure: String = "", arrival: String = "", totalHours: Double = 0,
         dualHours: Double = 0, soloHours: Double = 0, dayLandings: Int = 0,
         nightLandings: Int = 0, maneuvers: [String] = [], notes: String = "") {
        self.date = date
        self.aircraftType = aircraftType
        self.tailNumber = tailNumber
        self.departure = departure
        self.arrival = arrival
        self.totalHours = totalHours
        self.dualHours = dualHours
        self.soloHours = soloHours
        self.dayLandings = dayLandings
        self.nightLandings = nightLandings
        self.maneuvers = maneuvers
        self.notes = notes
    }

    var route: String {
        let from = departure.isEmpty ? "—" : departure
        let to = arrival.isEmpty ? from : arrival
        return from == to ? from : "\(from) → \(to)"
    }
}

enum Maneuver {
    /// Common private-pilot training items, offered as quick picks.
    static let common = [
        "Steep turns", "Slow flight", "Power-off stalls", "Power-on stalls",
        "Ground reference", "Emergency descent", "Simulated engine failure",
        "Short-field landing", "Soft-field landing", "Crosswind landing",
        "Go-around", "Pattern work", "Navigation", "Hood work",
    ]
}
