# Guidepost

Guidepost is a Python library designed for seamless integration into Jupyter notebooks to visualize High Performance Computing (HPC) job data. It simplifies the process of understanding HPC workloads by providing a single, interactive visualization that offers an intuitive overview of job performance, resource usage, and other critical metrics.

---

## Features

- **Jupyter Notebook Integration**: Designed for your existing workflow. Load and interact with the visualization directly in your Jupyter environment.
- **HPC Job Data Insights**: Visualize key metrics, including job runtimes, resource usage, and queue performance.
- **Interactive Exploration**: Export selections of specific jobs or groups of jobs for deeper analysis.
- **Lightweight and Easy to Use**: Focused on simplicity and efficiency for HPC users.

---

## Installation

Guidepost is available on PyPI. You can install it using pip:

```bash
pip install guidepost
```

---

## Quick Start

### 1. Import Guidepost

```python
import guidepost as gp
```

### 2. Load Your Data
Guidepost supports input data in CSV or Pandas DataFrame format. Ensure your data includes columns such as job IDs, runtime, and resource usage.

```python
import pandas as pd

data = pd.read_csv("hpc_jobs.csv")
```

### 3. Generate Visualization

```python
gp.load_visualization(data)
```

Run the above command in a Jupyter notebook cell to render the visualization directly.

---

## Example Dataset
Below is an example of the kind of data Guidepost works with:

| Job ID | Runtime (hours) | Nodes Used | partition | Status |
|--------|-----------------|------------|-----------|--------|
| 12345  | 5.2             | 10         | short | Complete |
| 12346  | 12.0            | 20         | long  | Running  |

Note that a column named "parition" must be sepecified.

---

## API Reference

### `load_visualization(data)`
- **Description**: Renders the HPC job data visualization in the current Jupyter notebook.
- **Parameters**:
  - `data` (DataFrame or str): A Pandas DataFrame or a path to a CSV file containing HPC job data.

---

## Contributing

Contributions to Guidepost are welcome! To contribute:

1. Fork the repository.
2. Create a new branch for your feature or bugfix.
3. Submit a pull request with a detailed description of your changes.

---

## License

Guidepost is licensed under the MIT License. See the `LICENSE` file for details.

---

## Acknowledgments

Guidepost was developed to simplify the analysis of HPC workloads, inspired by the challenges faced by HPC administrators and researchers. Thank you to the open-source community for their support and tools.

---

## Contact

For questions or feedback, please reach out to the maintainers at [your-email@example.com].

