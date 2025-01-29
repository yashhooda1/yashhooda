import math

def calculate_pace(time_in_minutes, distance_in_miles):
    """Calculate average pace from time and distance."""
    if time_in_minutes <= 0 or distance_in_miles <= 0:
        return "Time and distance must be greater than zero."
    pace = time_in_minutes / distance_in_miles
    return f"Your average pace is {pace:.2f} minutes per mile."

def calculate_distance(average_pace, time_in_minutes):
    """Calculate distance from pace and time."""
    if average_pace <= 0 or time_in_minutes <= 0:
        return "Pace and time must be greater than zero."
    distance = time_in_minutes / average_pace
    return f"Your total distance is {distance:.2f} miles."

def calculate_time(average_pace, total_distance):
    """Calculate total time from pace and distance."""
    if average_pace <= 0 or total_distance <= 0:
        return "Pace and distance must be greater than zero."
    time = total_distance * average_pace
    return f"Your total time is {time:.2f} minutes."

def predict_race_time(running_time, running_distance, predicted_distance):
    """Predict race time for a given goal distance."""
    if running_time <= 0 or running_distance <= 0 or predicted_distance <= 0:
        return "All times and distances must be greater than zero."
    predicted_time = running_time * math.pow(predicted_distance / running_distance, 1.06)
    return f"Your predicted race time for {predicted_distance:.2f} miles is {predicted_time:.2f} minutes."

def calculate_training_paces(predicted_race_time):
    """Calculate training paces based on 1-mile race time."""
    paces = {
        "Easy Run Pace": 1.50 * predicted_race_time,
        "Tempo Run Pace": 1.25 * predicted_race_time,
        "VO2 Max Run Pace": 1.35 * predicted_race_time,
        "Speed Run Pace": 1.10 * predicted_race_time,
        "Long Run Pace": 1.55 * predicted_race_time,
    }
    return {key: f"{value:.2f} minutes per mile" for key, value in paces.items()}

def calculate_vo2max(running_time, running_distance, gender, body_weight):
    """Calculate VO2 max."""
    if running_time <= 0 or running_distance <= 0:
        return "Running time and distance must be greater than zero."
    test_completion_time = running_time * math.pow(1.5 / running_distance, 1.06)
    gender_factor = 1 if gender == "M" else 0
    vo2max = (
        88.02 + (3.716 * gender_factor) - (0.0753 * body_weight) - (2.767 * test_completion_time)
    )
    return f"Your VO2 max is estimated to be: {vo2max:.2f} ml/kg."
