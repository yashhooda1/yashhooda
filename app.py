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

@app.route('/calculator', methods=['POST'])
def calculate():
    try:
        goal = request.form.get('goal')
        print(f"Received goal: {goal}")

        if goal == 'pace':
            time = float(request.form.get('time', 0))
            distance = float(request.form.get('distance', 0))
            print(f"Time: {time}, Distance: {distance}")
            result = calculate_pace(time, distance)

        elif goal == 'distance':
            pace = float(request.form.get('pace', 0))
            time = float(request.form.get('time', 0))
            print(f"Pace: {pace}, Time: {time}")
            result = calculate_distance(pace, time)

        elif goal == 'time':
            pace = float(request.form.get('pace', 0))
            distance = float(request.form.get('distance', 0))
            print(f"Pace: {pace}, Distance: {distance}")
            result = calculate_time(pace, distance)

        elif goal == 'predict_race_time':
            running_time = float(request.form.get('running_time', 0))
            running_distance = float(request.form.get('running_distance', 0))
            predicted_distance = float(request.form.get('predicted_distance', 0))
            print(f"Running Time: {running_time}, Running Distance: {running_distance}, Predicted Distance: {predicted_distance}")
            result = predict_race_time(running_time, running_distance, predicted_distance)

        elif goal == 'training_paces':
            predicted_race_time = float(request.form.get('predicted_race_time', 0))
            print(f"Predicted Race Time: {predicted_race_time}")
            result = calculate_training_paces(predicted_race_time)

        elif goal == 'vo2max':
            running_time = float(request.form.get('running_time', 0))
            running_distance = float(request.form.get('running_distance', 0))
            gender = request.form.get('gender')
            body_weight = float(request.form.get('body_weight', 0))
            print(f"Running Time: {running_time}, Running Distance: {running_distance}, Gender: {gender}, Body Weight: {body_weight}")
            result = calculate_vo2max(running_time, running_distance, gender, body_weight)

        else:
            return jsonify({"error": "Invalid calculation type selected."}), 400

        return jsonify({"result": result})

    except Exception as e:
        print(f"Error: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True)
