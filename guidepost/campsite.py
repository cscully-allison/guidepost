import os
import socket
import subprocess
import atexit
import signal
import threading
import warnings
import pandas as pd
import traitlets
import anywidget
import uuid
from .utils import (
    validate_and_clean_dataframe,
    extract_summary_statistics,
)

def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


class LocalNodeServer:
    """
    Singleton Node server manager.
    Ensures exactly one Node process per kernel.
    """
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialized = False
            return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self.port = find_free_port()
        self.process = None
        self.node_file = os.path.join(
            os.path.dirname(__file__), "static", "server.js"
        )
        self.logfile = os.path.join(
            os.path.dirname(__file__), "node_server.log"
        )

        atexit.register(self.stop)
        self._initialized = True

    def start(self):
        if self.process is not None and self.process.poll() is None:
            return  # already running

        self.process = subprocess.Popen(
            ["node", self.node_file, str(self.port)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True  # 👈 critical for killing process tree
        )

        with open(self.logfile, "a") as f:
            f.write(f"Starting server on pid: {self.process.pid}\n")

        # Wait for READY signal
        for line in self.process.stdout:
            if f"READY:{self.port}" in line:
                break

    def stop(self):
        if self.process and self.process.poll() is None:
            with open(self.logfile, "a") as f:
                f.write(f"Shutting down Node server on pid:{self.process.pid}\n")

            try:
                os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
            except Exception:
                pass

        self.process = None


class Campsite(anywidget.AnyWidget):
    _esm = os.path.join(
        os.path.dirname(__file__), "static", "campsite", "campsite.js"
    )


    _session_id = traitlets.Unicode("0").tag(sync=True)
    _node_server_endpoint = traitlets.Unicode("").tag(sync=True)
    _vis_data = traitlets.Dict({}).tag(sync=True)
    _summary_stats = traitlets.Dict({}).tag(sync=True)
    vis_configs = traitlets.Dict({}).tag(sync=True)

    suppress_warnings = False

    # 👇 singleton server shared across all Campsite instances
    node_server = LocalNodeServer()

    def __init__(self):
        super().__init__()
        self.node_server.start()
        self._node_server_endpoint = f"http://localhost:{self.node_server.port}"
        self._session_id = uuid.uuid4().hex

    @property
    def records(self):
        return self._vis_data

    @records.setter
    def records(self, df):
        self._vis_data = self.load_data(df)

    def load_data(self, in_df):
        """
        Load dataframe and extract summary statistics for visualization.
        """
        if not isinstance(in_df, pd.DataFrame):
            try:
                in_df = pd.DataFrame(in_df)
            except Exception:
                raise ValueError(
                    "in_df must be a pandas DataFrame or convertible to one"
                )

        if not self.suppress_warnings and in_df.empty:
            warnings.warn("load_data called with an empty DataFrame")

        o_df, report = validate_and_clean_dataframe(
            in_df, self.suppress_warnings
        )
        self._summary_stats = extract_summary_statistics(o_df)

        return self._summary_stats

    def test_server(self):
        import requests
        response = requests.get(
            f"http://localhost:{self.node_server.port}/ping"
        )
        print(response.text)

    def analyze(self, q):
        import requests
        response = requests.post(
            url=f"http://localhost:{self.node_server.port}/analyze",
            json={"sessionId": "0", "question": q},
        )
        self.response = response.text



#  import anywidget
# import traitlets
# import pandas as pd
# import warnings
# import os
# from .utils import convert_to_float, validate_and_clean_dataframe, extract_summary_statistics
# import json

# import subprocess
# import socket
# import atexit


# def find_free_port():
#     with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
#         s.bind(("", 0))
#         return s.getsockname()[1]
    

# class LocalNodeServer:
#     def __init__(self):
#         self.port = find_free_port()
#         self.process = None
#         self.node_file = os.path.join(os.path.dirname(__file__), "static", "server.js")

#         self.logfile = os.path.join(os.path.dirname(__file__), "node_server.log")

#         atexit.register(self.stop)

#     def start(self):
#         self.process = subprocess.Popen( 
#             ["node", self.node_file, str(self.port)],
#             stdout=subprocess.PIPE,
#             stderr=subprocess.PIPE,
#             text=True
#         )
        
#         with open(self.logfile, "a") as f:
#                 f.write(f"Starting server on pid: {self.process.pid}\n")

#         # Wait for READY signal
#         while True:
#             line = self.process.stdout.readline()
#             if f"READY:{self.port}" in line:
#                 break

#     def stop(self):
#         if self.process:
#             with open(self.logfile, "a") as f:
#                 f.write(f"Shutting down Node server on pid:{self.process.pid}\n")
#             self.process.terminate()


# class Campsite(anywidget.AnyWidget):
#     _esm = os.path.join(os.path.dirname(__file__), "static", "campsite", "campsite.js")
#     _vis_data = traitlets.Dict({}).tag(sync=True)
#     _summary_stats = traitlets.Dict({}).tag(sync=True)
#     records = None
#     vis_configs = traitlets.Dict({}).tag(sync=True)
#     suppress_warnings = False
#     node_server = LocalNodeServer()
    
#     def __init__(self):
#         self.node_server.start()

#     @property
#     def records(self):
#         return self._vis_data
    
#     @records.setter
#     def records(self, df):
#         self._vis_data = self.load_data(df)

#     def load_data(self, in_df):
#         '''
#             Load dataframe and extract summary statistics for visualization.
#         '''
#     # validate / coerce dataframe
#         if not isinstance(in_df, pd.DataFrame):
#             try:
#                 in_df = pd.DataFrame(in_df)
#             except Exception:
#                 raise ValueError("in_df must be a pandas DataFrame or convertible to one")

#         if not self.suppress_warnings and in_df.empty:
#             warnings.warn("load_data called with an empty DataFrame")

#         o_df, report = validate_and_clean_dataframe(in_df, self.suppress_warnings)
#         self._summary_stats = extract_summary_statistics(o_df)

#         return self._summary_stats
    
#     def test_server(self):
#         import requests
#         response = requests.get(f"http://localhost:{self.node_server.port}/ping")
#         print(response.text)

#     def analyze(self, q):
#         import requests
#         response = requests.post(url=f"http://localhost:{self.node_server.port}/analyze", json={'sessionId': '0', 'question':q})
#         self.response = response.text
