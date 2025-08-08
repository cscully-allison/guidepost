from setuptools import setup, find_packages
from codecs import open
from os import path

here = path.abspath(path.dirname(__file__))

with open(path.join(here, "README.md"), "r", encoding="utf-8") as fh:
    long_description = fh.read()

# Get the version in a safe way
# per python docs: https://packaging.python.org/guides/single-sourcing-package-version/
version = {}
with open("./guidepost/version.py") as fp:
    exec(fp.read(), version)

setup(
    name='guidepost',
    version=version["__version__"],
    author='Connor Scully-Allison',
    author_email='cscullyallison@sci.utah.edu',
    description='Guidepost. An overview visualization for understanding supercomputer queue data.',
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/cscully-allison/guidepost",
    packages=find_packages(),
    install_requires=[
        'numpy',
        'pandas',
        'scikit-learn',
        'anywidget',
        'traitlets'
    ],
    classifiers=[
        'Programming Language :: Python :: 3',
        'License :: OSI Approved :: MIT License',
        'Operating System :: OS Independent',
    ],
    python_requires='>=3.6',
    include_package_data=True,
    package_data={
        'guidepost': ['guidepost.js'],
        'figs':['guidepost_tutorial_info.png']
    },
)
