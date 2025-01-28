from flask import Flask, render_template, request, jsonify
import math

app = Flask(__name__)

# Serve the main HTML file
@app.route('/')
def home():
    return render_template('index.html')

# Endpoint for the Running Conversion Calculator
@app.route('/calculate', methods=['POST'])
def calculate():
    try:
        # Retrieve the goal and relevant fields from the form
        goal = request.form.get('goal')

        if goal == 'pace':
            time = float(request.form.get('time', 0))
            distance = float(request.form.get('distance', 0))
            if time > 0 and distance > 0:
                pace = time / distance
                return jsonify({"result": f"Your average pace is {pace:.2f} minutes per mile."})
            else:
                return jsonify({"error": "Time and distance must be greater than zero."}), 400

        elif goal == 'distance':
            pace = float(request.form.get('pace', 0))
            time = float(request.form.get('time', 0))
            if pace > 0 and time > 0:
                distance = time / pace
                return jsonify({"result": f"Your total distance is {distance:.2f} miles."})
            else:
                return jsonify({"error": "Pace and time must be greater than zero."}), 400

        elif goal == 'time':
            pace = float(request.form.get('pace', 0))
            distance = float(request.form.get('distance', 0))
            if pace > 0 and distance > 0:
                time = pace * distance
                return jsonify({"result": f"Your total time is {time:.2f} minutes."})
            else:
                return jsonify({"error": "Pace and distance must be greater than zero."}), 400

        elif goal == 'predict_race_time':
            running_time = float(request.form.get('running_time', 0))
            running_distance = float(request.form.get('running_distance', 0))
            predicted_distance = float(request.form.get('predicted_distance', 0))
            if running_time > 0 and running_distance > 0 and predicted_distance > 0:
                predicted_time = running_time * pow(predicted_distance / running_distance, 1.06)
                return jsonify({"result": f"Your predicted race time for {predicted_distance:.2f} miles is {predicted_time:.2f} minutes."})
            else:
                return jsonify({"error": "All distances and times must be greater than zero."}), 400

        else:
            return jsonify({"error": "Invalid calculation type selected."}), 400

    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500

if __name__ == "__main__":
    app.run(debug=True)
