import CoreLocation
import Foundation
import Observation

struct Conditions {
    let temperatureF: Double
    let feelsLikeF: Double?
    let humidityPct: Double?
    let windMph: Double?
}

struct AirQuality {
    let usAQI: Double
    let pm25: Double?

    /// US EPA AQI bands.
    var band: String {
        switch usAQI {
        case ..<51: return "Good"
        case ..<101: return "Moderate"
        case ..<151: return "Unhealthy for sensitive groups"
        case ..<201: return "Unhealthy"
        case ..<301: return "Very unhealthy"
        default: return "Hazardous"
        }
    }
}

struct WeatherAlert: Identifiable {
    let id: String
    let event: String
    let headline: String?
    let severity: String?
}

/// Current conditions where the phone is.
///   Weather and air quality: Open-Meteo (no key, no account).
///   Alerts: api.weather.gov, which covers the United States only.
@Observable
final class HereStore: NSObject, CLLocationManagerDelegate {
    var conditions: Conditions?
    var air: AirQuality?
    var alerts: [WeatherAlert] = []
    var alertsCovered = true
    var placeName: String?
    var isLoading = false
    var error: String?
    var locationDenied = false

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    func refresh() {
        error = nil
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            locationDenied = true
        default:
            isLoading = true
            manager.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            locationDenied = false
            isLoading = true
            manager.requestLocation()
        case .denied, .restricted:
            locationDenied = true
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { await load(location) }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.isLoading = false
            self.error = "Could not get your location: \(error.localizedDescription)"
        }
    }

    @MainActor
    private func load(_ location: CLLocation) async {
        defer { isLoading = false }
        // Two decimals is about 1 km: enough for weather, and it keeps the exact
        // position out of third-party request logs.
        let lat = String(format: "%.2f", location.coordinate.latitude)
        let lon = String(format: "%.2f", location.coordinate.longitude)

        if let place = try? await CLGeocoder().reverseGeocodeLocation(location).first {
            placeName = [place.locality, place.administrativeArea].compactMap { $0 }.joined(separator: ", ")
        }

        do {
            let url = URL(string: "https://api.open-meteo.com/v1/forecast?latitude=\(lat)&longitude=\(lon)"
                + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m"
                + "&temperature_unit=fahrenheit&wind_speed_unit=mph")!
            guard let root = try await HTTP.json(url) as? [String: Any],
                  let current = root["current"] as? [String: Any],
                  let temp = current.double("temperature_2m") else { throw HTTP.Failure.badPayload }
            conditions = Conditions(
                temperatureF: temp,
                feelsLikeF: current.double("apparent_temperature"),
                humidityPct: current.double("relative_humidity_2m"),
                windMph: current.double("wind_speed_10m")
            )
        } catch {
            self.error = "Weather: \(error.localizedDescription)"
        }

        // Air quality and alerts are extras: a failure leaves that card empty
        // instead of replacing the conditions that did load.
        let airURL = URL(string: "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=\(lat)&longitude=\(lon)&current=us_aqi,pm2_5")!
        if let root = try? await HTTP.json(airURL) as? [String: Any],
           let current = root["current"] as? [String: Any],
           let aqi = current.double("us_aqi") {
            air = AirQuality(usAQI: aqi, pm25: current.double("pm2_5"))
        } else {
            air = nil
        }

        let alertURL = URL(string: "https://api.weather.gov/alerts/active?point=\(lat),\(lon)")!
        do {
            guard let root = try await HTTP.json(alertURL, accept: "application/geo+json") as? [String: Any],
                  let features = root["features"] as? [[String: Any]] else { throw HTTP.Failure.badPayload }
            alertsCovered = true
            alerts = features.compactMap { feature in
                guard let props = feature["properties"] as? [String: Any],
                      let event = props.string("event") else { return nil }
                return WeatherAlert(
                    id: props.string("id") ?? UUID().uuidString,
                    event: event,
                    headline: props.string("headline"),
                    severity: props.string("severity")
                )
            }
        } catch {
            // Outside the US the point lookup fails. That is "no coverage", not "no alerts".
            alertsCovered = false
            alerts = []
        }
    }
}
