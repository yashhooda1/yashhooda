# calculator.py

import math

def calculate_pace(time, distance):
    """Calculate average pace from time and distance."""
    if time <= 0 or distance <= 0:
        return "Time and distance must be greater than zero."
    pace = time / distance
    return f"Your average pace is {pace:.2f} minutes per mile."

def calculate_distance(pace, time):
    """Calculate distance from pace and time."""
    if pace <= 0 or time <= 0:
        return "Pace and time must be greater than zero."
    distance = time / pace
    return f"Your total distance is {distance:.2f} miles."

def calculate_time(pace, distance):
    """Calculate total time from pace and distance."""
    if pace <= 0 or distance <= 0:
        return "Pace and distance must be greater than zero."
    time = pace * distance
    return f"Your total time is {time:.2f} minutes."

def predict_race_time(running_time, running_distance, predicted_distance):
    """Predict race time for a given goal distance."""
    if running_time <= 0 or running_distance <= 0 or predicted_distance <= 0:
        return "All times and distances must be greater than zero."
    predicted_time = running_time * math.pow(predicted_distance / running_distance, 1.06)
    return f"Your predicted race time for {predicted_distance:.2f} miles is {predicted_time:.2f} minutes."