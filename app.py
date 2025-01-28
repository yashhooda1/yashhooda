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
        goal = request.form['goal']

        if goal == 'pace':
            time = float(request.form['time'])
            distance = float(request.form['distance'])
            pace = time / distance
            return jsonify({"result": f"Your average pace is {pace:.2f} minutes per mile."})

        elif goal == 'distance':
            pace = float(request.form['pace'])
            time = float(request.form['time'])
            distance = time / pace
            return jsonify({"result": f"Your total distance is {distance:.2f} miles."})

        elif goal == 'time':
            pace = float(request.form['pace'])
            distance = float(request.form['distance'])
            time = pace * distance
            return jsonify({"result": f"Your total time is {time:.2f} minutes."})

        elif goal == 'predict_race_time':
            running_time = float(request.form['running_time'])
            running_distance = float(request.form['running_distance'])
            predicted_distance = float(request.form['predicted_distance'])
            predicted_time = running_time * pow(predicted_distance / running_distance, 1.06)
            return jsonify({"result": f"Your predicted race time for {predicted_distance:.2f} miles is {predicted_time:.2f} minutes."})

        else:
            return jsonify({"error": "Invalid calculation type selected."}), 400

    except KeyError as e:
        return jsonify({"error": f"Missing field: {e}"}), 400

    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(debug=True)
