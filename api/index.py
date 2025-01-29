import os
from flask import Flask, render_template, request, jsonify
from calculator import (
    calculate_pace,
    calculate_distance,
    calculate_time,
    predict_race_time,
    calculate_training_paces,
    calculate_vo2max,
)

app = Flask(__name__)

@app.route('/')
def home():
    return render_template('index.html')

# Required for Vercel
def handler(event, context):
    return app(event, context)

# Required for Vercel (Fixing Serverless Function Issue)
from flask_lambda import FlaskLambda

app = FlaskLambda(app)  # Convert Flask app to work with serverless functions

@app.route('/calculator', methods=['POST'])
def calculate():
    try:
        data = request.get_json()  # <-- Get JSON payload
        goal = data.get('goal')
        print(f"Received goal: {goal}")

        if goal == 'pace':
            time = float(data.get('time', 0))
            distance = float(data.get('distance', 0))
            result = calculate_pace(time, distance)

        elif goal == 'distance':
            pace = float(data.get('pace', 0))
            time = float(data.get('time', 0))
            result = calculate_distance(pace, time)

        elif goal == 'time':
            pace = float(data.get('pace', 0))
            distance = float(data.get('distance', 0))
            result = calculate_time(pace, distance)

        elif goal == 'predict_race_time':
            running_time = float(data.get('running_time', 0))
            running_distance = float(data.get('running_distance', 0))
            predicted_distance = float(data.get('predicted_distance', 0))
            result = predict_race_time(running_time, running_distance, predicted_distance)

        elif goal == 'training_paces':
            predicted_race_time = float(data.get('predicted_race_time', 0))
            result = calculate_training_paces(predicted_race_time)

        elif goal == 'vo2max':
            running_time = float(data.get('running_time', 0))
            running_distance = float(data.get('running_distance', 0))
            gender = data.get('gender')
            body_weight = float(data.get('body_weight', 0))
            result = calculate_vo2max(running_time, running_distance, gender, body_weight)

        else:
            return jsonify({"error": "Invalid calculation type selected."}), 400

        return jsonify({"result": result})

    except Exception as e:
        print(f"Error: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(debug=True)
