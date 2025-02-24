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

### 1. Import and Initialize Guidepost

```python
from guidepost import Guidepost
gp = Guidepost()
```

### 2. Load Your Data
Guidepost supports input data in CSV or Pandas DataFrame format. Ensure your data includes columns such as job IDs, runtime, and resource usage.

```python
import pandas as pd

jobs_data = pd.read_parquet("data/jobs_data.parquet")
```

### 3. Configure Visualization

```python
gp.vis_data = jobs_data
gp.vis_configs = {
        'x': 'queue_wait',
        'y': 'start_time',
        'color': 'nodes_req',
        'color_agg': 'avg',
        'categorical': 'user'
}
```

### 4. Run Visualization
```python
gp
```

Run the above command in a Jupyter notebook cell to load data.

### 4. Retrieve Selections from Visualization
```python
gp.retrieve_selected_data()
```

---

## Example Dataset
Below is an example of the kind of data Guidepost works with:

| Job ID | Runtime (hours) | Nodes Used | partition | Status |
|--------|-----------------|------------|-----------|--------|
| 12345  | 5.2             | 10         | short | Complete |
| 12346  | 12.0            | 20         | long  | Running  |


Note that a column named "partition" must be sepecified.

---

## API Reference

### `vis_data`
- **Description**: Holds the vis data to passed to the visualization. Updates to this variable will automatically update the visualization.


### `vis_configs`
- **Description**: Holds the vis configurations to passed to the visualization. Updates to this variable will automatically update the visualization.

Vis configurations must be specified as a python dictonary with the following fields:
- 'x': The column from the pandas dataframe which will be shown on the x axis. This can be a integer, float or datetime variable.
- 'y': The column from the pandas dataframe which will be shown on the y axis of this visualization. This can be an integer or float.
- 'color': The column from the pandas dataframe which will determine the color of squares in the main summary view. This can be an integer or float.
- 'color_agg': This is a specification for what aggregation is used for the color variable. It can be: 'avg', 'variance', 'std', 'sum', or 'median'
- 'categorical': A categorical variable from the dataset. It must be a string. The visualization will show the top 7 instances of this variable. 



### `retrieve_selected_data()`
- **Description**: Returns selected data back from the visualization. 
- **Returns**:
  - `subselection` (DataFrame or str): A Pandas DataFrame that contains subselected data specified from selections made to the visualization.

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

Guidepost was developed under the auspices and with funding provided by the National Renewable Energy Laboratory (NREL).

---

## Contact

For questions or feedback, please reach out to the maintainer at [cscullyallison@sci.utah.edu].

